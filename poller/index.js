/* Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */

/*
 * Autoscaler Poller function
 *
 * * Polls one or more Spanner instances for metrics.
 * * Sends metrics to Scaler to determine if an instance needs to be autoscaled
 */

const monitoring = require('@google-cloud/monitoring');
const {PubSub} = require('@google-cloud/pubsub');
const {Spanner} = require('@google-cloud/spanner');

// GCP service clients
const metricsClient = new monitoring.MetricServiceClient();
const pubSub = new PubSub();
const spannerDefaults = {
  minNodes: 1,
  maxNodes: 3,
  stepSize: 2,
  overloadStepSize: 5,
  scaleOutCoolingMinutes: 5,
  scaleInCoolingMinutes: 30,
  scalingMethod: 'STEPWISE'
};

function log(message, severity = 'DEBUG', payload) {
  // Structured logging
  // https://cloud.google.com/functions/docs/monitoring/logging#writing_structured_logs

  if (!!payload) {
    // If payload is an Error, get the stack trace.
    if (payload instanceof Error && !!payload.stack) {
      if (!!message ) {
         message = message + '\n' + payload.stack;
      } else {
         message = payload.stack;
      }
    }
  }

  const logEntry = {
    message: message,
    severity: severity,
    payload: payload
  };
  console.log(JSON.stringify(logEntry));
}

function buildMetrics(projectId, instanceId) {
  // Recommended alerting policies
  // https://cloud.google.com/spanner/docs/monitoring-stackdriver#create-alert
  const metrics = [
    {
      name: 'high_priority_cpu',
      filter: 'resource.labels.instance_id="' + instanceId + '" AND ' +
          'resource.type="spanner_instance" AND ' +
          'project="' + projectId + '" AND ' +
          'metric.type="spanner.googleapis.com/instance/cpu/utilization_by_priority" AND ' +
          'metric.label.priority="high"',
      reducer: 'REDUCE_SUM',
      aligner: 'ALIGN_MAX',
      period: 60,
      regional_threshold: 65,
      multi_regional_threshold: 45
    },
    {
      name: 'rolling_24_hr',
      filter: 'resource.labels.instance_id="' + instanceId + '" AND ' +
          'resource.type="spanner_instance" AND ' +
          'project="' + projectId + '" AND ' +
          'metric.type="spanner.googleapis.com/instance/cpu/smoothed_utilization"',
      reducer: 'REDUCE_SUM',
      aligner: 'ALIGN_MAX',
      period: 60,
      regional_threshold: 90,
      multi_regional_threshold: 90
    },
    {
      name: 'storage',
      filter: 'resource.labels.instance_id="' + instanceId + '" AND ' +
          'resource.type="spanner_instance" AND ' +
          'project="' + projectId + '" AND ' +
          'metric.type="spanner.googleapis.com/instance/storage/utilization"',
      reducer: 'REDUCE_SUM',
      aligner: 'ALIGN_MAX',
      period: 60,
      regional_threshold: 75,
      multi_regional_threshold: 75
    }
  ];

  return metrics;
}

function getMaxMetricValue(projectId, spannerInstanceId, metric) {
  const metricWindow = 5;
  log(`Get max ${metric.name} from ${projectId}/${spannerInstanceId} over ${metricWindow} minutes.`);

  const request = {
    name: 'projects/' + projectId,
    filter: metric.filter,
    interval: {
      startTime: {
        seconds: Date.now() / 1000 - metric.period * metricWindow,
      },
      endTime: {
        seconds: Date.now() / 1000,
      }
    },
    aggregation: {
      alignmentPeriod: {
        seconds: metric.period,
      },
      crossSeriesReducer: metric.reducer,
      perSeriesAligner: metric.aligner,
    },
    view: 'FULL'
  };

  return metricsClient.listTimeSeries(request).then(metricResponses => {
    const resources = metricResponses[0];
    maxValue = 0.0;
    for (const resource of resources) {
      for (const point of resource.points) {
        value = parseFloat(point.value.doubleValue) * 100;
        if (value > maxValue) {
          maxValue = value;
        }
      }
    }
    return maxValue;
  });
}

function getSpannerMetadata(projectId, spannerInstanceId) {
  log(`----- ${projectId}/${spannerInstanceId}: Getting Metadata -----`,
      'INFO');

  const spanner = new Spanner({
    projectId: projectId,
  });
  const spannerInstance = spanner.instance(spannerInstanceId);


  return spannerInstance.getMetadata().then(data => {
    const metadata = data[0];
    log(`DisplayName: ${metadata['displayName']}`);
    log(`NodeCount:   ${metadata['nodeCount']}`);
    log(`Config:      ${metadata['config'].split('/').pop()}`);

    const spannerMetadata = {
      currentNodes: metadata['nodeCount'],
      regional: metadata['config'].split('/').pop().startsWith('regional')
    };

    return spannerMetadata;
  });
}

function postPubSubMessage(spanner, metrics) {
  const topic = pubSub.topic(spanner.scalerPubSubTopic);

  spanner.metrics = metrics;
  const messageBuffer = Buffer.from(JSON.stringify(spanner), 'utf8');

  return topic.publish(messageBuffer)
      .then(
          log(`----- Published message to topic: ${spanner.scalerPubSubTopic}`,
              'INFO', spanner))
      .catch(err => {
        log(`An error occurred when publishing the message to ${spanner.scalerPubSubTopic}`,
            'ERROR', err);
      });
}

async function parseAndEnrichPayload(payload) {
  var spanners = JSON.parse(payload);

  for (var sIdx = 0; sIdx < spanners.length; sIdx++) {
    const metricOverrides = spanners[sIdx].metrics;

    // merge in the defaults
    spanners[sIdx] = {...spannerDefaults, ...spanners[sIdx]};

    spanners[sIdx].metrics =
      buildMetrics(spanners[sIdx].projectId, spanners[sIdx].instanceId);
    // merge in custom thresholds
    if(metricOverrides != null) {
      for (var oIdx = 0; oIdx < metricOverrides.length; oIdx++) {
        mIdx = spanners[sIdx].metrics.findIndex(x => x.name === metricOverrides[oIdx].name);
        if(mIdx != -1) {
          spanners[sIdx].metrics[mIdx] = {...spanners[sIdx].metrics[mIdx], ...metricOverrides[oIdx]};
        }
      }
    }

    // merge in the current Spanner state
    spanners[sIdx] = {
      ...spanners[sIdx],
      ...await getSpannerMetadata(spanners[sIdx].projectId, spanners[sIdx].instanceId)
    };
  }

  return spanners;
}

async function getMetrics(spanner) {
  log(`----- ${spanner.projectId}/${spanner.instanceId}: Getting Metrics -----`,
      'INFO');
  var metrics = [];
  for (const metric of spanner.metrics) {
    var maxMetricValue =
        await getMaxMetricValue(spanner.projectId, spanner.instanceId, metric);
    const threshold = (spanner.regional) ? metric.regional_threshold :
                                           metric.multi_regional_threshold;

    var aboveOrUnder = ((maxMetricValue > threshold) ? 'ABOVE' : 'UNDER');
    log(`	 ${metric.name} = ${maxMetricValue}, ${aboveOrUnder} the ${threshold} threshold.`);

    const metricsObject = {
      name: metric.name,
      threshold: threshold,
      value: maxMetricValue
    };
    metrics.push(metricsObject);
  }
  return metrics;
}

async function checkSpanners(payload) {
  const spanners = await parseAndEnrichPayload(payload);
  log('Autoscaler poller started.', 'DEBUG', spanners);

  for (const spanner of spanners) {
    var metrics = await getMetrics(spanner);
    postPubSubMessage(spanner, metrics);
  }
}

exports.checkSpannerScaleMetricsPubSub = async (pubSubEvent, context) => {
  try {
    const payload = Buffer.from(pubSubEvent.data, 'base64').toString();

    await checkSpanners(payload);
  } catch (err) {
    log(`An error occurred in the Autoscaler poller function`, 'ERROR', err);
  }
};

// For testing with: https://cloud.google.com/functions/docs/functions-framework
exports.checkSpannerScaleMetricsHTTP = async (req, res) => {
  try {
    const payload =
        '[{"projectId": "spanner-scaler", "instanceId": "autoscale-test", "scalerPubSubTopic": "projects/spanner-scaler/topics/test-scaling", "minNodes": 1, "maxNodes": 3, "stateProjectId" : "spanner-scaler"}]';

    await checkSpanners(payload);
    res.status(200).end();
  } catch (err) {
    log(`An error occurred in the Autoscaler poller function`, 'ERROR', err);
    res.status(500).end(err.toString());
  }
};
