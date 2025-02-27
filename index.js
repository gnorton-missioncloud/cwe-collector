/* -----------------------------------------------------------------------------
 * @copyright (C) 2017, Alert Logic, Inc
 * @doc
 *
 * Lambda function for collecting Amazon CloudWatch events and ingesting them
 * into Alert Logic backend.
 *
 * @end
 * -----------------------------------------------------------------------------
 */
 
const debug = require('debug') ('index'); 
const AWS = require('aws-sdk');
const async = require('async');

const { Util: m_alAws } = require('@alertlogic/al-aws-collector-js');
const { Stats: m_statsTemplate } = require('@alertlogic/al-aws-collector-js');
const AlLogger = require('@alertlogic/al-aws-collector-js').Logger;
const m_checkin = require('./checkin');
const cweCollector = require('./al-cwe-collector').cweCollector
let AIMS_CREDS;

function getDecryptedCredentials(callback) {
    if (AIMS_CREDS) {
        return callback(null);
    } else {
        const kms = new AWS.KMS();
        kms.decrypt(
            {CiphertextBlob: Buffer.from(process.env.aims_secret_key, 'base64')},
            (err, data) => {
                if (err) {
                    return callback(err);
                } else {
                    AIMS_CREDS = {
                        access_key_id: process.env.aims_access_key_id,
                        secret_key: data.Plaintext.toString('ascii')
                    };
                    return callback(null);
                }
            });
    }
}

function getKinesisData(event, callback) {
    async.map(event.Records, function(record, mapCallback) {
        var cwEvent = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
        try {
            return mapCallback(null, JSON.parse(cwEvent));
        } catch (ex) {
            AlLogger.warn(`Event parse failed. ${JSON.stringify(ex)}`);
            AlLogger.warn(`Skipping: ${JSON.stringify(record.kinesis.data)}`);
            return mapCallback(null, {});
        }
    }, callback);
}

function filterGDEvents(cwEvents, callback) {
    async.filter(cwEvents,
        function(cwEvent, filterCallback){
            var isValid = (typeof(cwEvent.source) !== 'undefined') &&
                 cwEvent.source === 'aws.guardduty' &&
                 cwEvent['detail-type'] === 'GuardDuty Finding';
            if (isValid) {
                debug(`DEBUG0002: filterGDEvents - including event: ` +
                    `${JSON.stringify(cwEvent)} `);
            } else {
                debug(`DEBUG0003: filterGDEvents - filtering out event: ` +
                    `${JSON.stringify(cwEvent)} `);
            }
            return filterCallback(null, isValid);
        },
        callback
    );
}

function formatMessages(event, context, callback) {
    async.waterfall([
        function(asyncCallback) {
            getKinesisData(event, asyncCallback);
        },
        function(kinesisData, asyncCallback) {
            filterGDEvents(kinesisData, asyncCallback);
        },
        function(collectedData, asyncCallback) {
            if (collectedData.length > 0) {
                return asyncCallback(null, { 
                    collected_batch : {
                        source_id : context.invokedFunctionArn,
                        collected_messages : collectedData
                    }
                });
            } else {
                return asyncCallback(null);
            }
        }],
        callback);
}




function getStatisticsFunctions(event) {
    if(!event.KinesisArn){
        return [];
    }
    const kinesisName = m_alAws.arnToName(event.KinesisArn);
    return [
       function(callback) {
           return m_statsTemplate.getKinesisMetrics(kinesisName,
               'IncomingRecords',
               callback);
       },
       function(callback) {
           return m_statsTemplate.getKinesisMetrics(kinesisName,
               'IncomingBytes',
               callback);
       },
       function(callback) {
           return m_statsTemplate.getKinesisMetrics(kinesisName,
               'ReadProvisionedThroughputExceeded',
               callback);
       },
       function(callback) {
           return m_statsTemplate.getKinesisMetrics(kinesisName,
               'WriteProvisionedThroughputExceeded',
               callback);
       }
    ];
}

// Migration code for old collectors.
// This needs to be done because the collector lambda does not have premissions to set its own env vars.
function envVarMigration(event) {
    if (!process.env.aws_lambda_update_config_name) {
        process.env.aws_lambda_update_config_name = 'configs/lambda/al-cwe-collector.json';
        m_alAws.setEnv({ aws_lambda_update_config_name: 'configs/lambda/al-cwe-collector.json' }, (err) => {
            if (err) {
                AlLogger.error('CWE error while adding aws_lambda_update_config_name in environment variable')
            }
        });
    }
    //add in the env var for the framework
    if ((!process.env.stack_name && event.StackName) || !process.env.al_application_id) {
        m_alAws.setEnv({ stack_name: event.StackName, al_application_id: 'guardduty' }, (err) => {
            if (err) {
                AlLogger.error('CWE error while adding stack_name in environment variable')
            }
        });
    }
}


exports.handler = function(event, context) {
    envVarMigration(event);
    async.waterfall([
        getDecryptedCredentials,
        function (asyncCallback) {
            /**  Some old collector has KMS permission issue and so we can't add the vairable in environment variable
             *  The process.env.azollect_api has missing c and so connection with azcollect is break, so start connection with azcollect, assinge the value to process.env.azcollect_api. 
             *  Set the collector_id to NA to not call the register api call in every check in event. 
             *  */
            if (process.env.azollect_api && !process.env.azcollect_api) {
                process.env.collector_id = 'NA';
                process.env.azcollect_api = process.env.azollect_api;
            }
           
            const collector = new cweCollector(
                context,
                AIMS_CREDS,
                formatMessages,
                [m_checkin.checkHealth(event, context)],
                getStatisticsFunctions(event)
            );

            debug("DEBUG0001: Received event: ", JSON.stringify(event));
            collector.handleEvent(event, asyncCallback);
        }
    ],
    function(err, result){
        if(err){
            context.fail(err);
        } else {
            context.succeed(result);
        }
    });
};
