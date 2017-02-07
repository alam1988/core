
/*
 Copyright [2016] [Relevance Lab]

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

var logger = require('_pr/logger')(module);
var async = require("async");
var apiUtil = require('_pr/lib/utils/apiUtil.js');
var logsDao = require('_pr/model/dao/logsdao.js');
var instanceModel = require('_pr/model/classes/instance/instance.js');
var instanceLogModel = require('_pr/model/log-trail/instanceLog.js');
var uuid = require('node-uuid');
var exec = require('exec');
const fileHound= require('filehound');
var Cryptography = require('_pr/lib/utils/cryptography');
var appConfig = require('_pr/config');
var auditTrailService = require('_pr/services/auditTrailService.js');
var credentialCryptography = require('_pr/lib/credentialcryptography');
var SSHExec = require('_pr/lib/utils/sshexec');
var SCP = require('_pr/lib/utils/scp');

const errorType = 'executor';

var executor = module.exports = {};

executor.executeScriptBot = function executeScriptBot(botsDetails,envId,userName,callback) {
    async.waterfall([
        function(next){
            var actionObj={
                auditType:'BOTsNew',
                auditCategory:'BOTs',
                status:'running',
                action:'BOTs Execution',
                actionStatus:'running',
                catUser:userName
            };
            var auditTrailObj = {
                name:botsDetails.name,
                type:botsDetails.action,
                description:botsDetails.desc,
                category:botsDetails.category,
                executionType:botsDetails.type,
                manualExecutionTime:botsDetails.manualExecutionTime
            };
            auditTrailService.insertAuditTrail(botsDetails,auditTrailObj,actionObj,next);
        },
        function(auditTrail,next){
            if(envId !== null || envId !== ''){
                executeScriptOnEnv(botsDetails,auditTrail,envId,userName,next);
            }else{
                executeScriptOnNode(botsDetails,auditTrail,next);
            }
        }
    ],function(err,result){
        if(err){
            callback(err,null);
        }else{
            callback(null,result);
        }
        
    })
}


function executeScriptOnNode(botsScriptDetails,auditTrail,callback) {
    var cryptoConfig = appConfig.cryptoSettings;
    var cryptography = new Cryptography(cryptoConfig.algorithm, cryptoConfig.password);
    var cmd = null, count = 0;
    var gitHubDirPath = appConfig.gitHubDir + botsScriptDetails.gitHubRepoName;
    var actionId = uuid.v4();
    var logsReferenceIds = [botsScriptDetails._id, actionId];
    for(var i = 0; i < botsScriptDetails.execution.length; i++) {
        (function(scriptObj) {
            fileHound.create()
                .paths(gitHubDirPath)
                .match(scriptObj.start)
                .ext('sh')
                .find().then(function (files) {
                if (scriptObj.sudoFlag && scriptObj.sudoFlag === true) {
                    cmd = 'sudo ' +scriptObj.type + ' ' + files[0];
                } else {
                    cmd = scriptObj.type + ' ' + files[0]
                }
                if(botsScriptDetails.params.length > 0) {
                    for (var j = 0; j < botsScriptDetails.params.length; j++) {
                        var decryptedText = cryptography.decryptText(botsScriptDetails.params[j], cryptoConfig.decryptionEncoding, cryptoConfig.encryptionEncoding);
                        cmd = cmd + ' ' + decryptedText;
                    }
                }
                exec(cmd, function(err, out, code) {
                    if(err){
                        count++;
                        logsDao.insertLog({
                            referenceId: logsReferenceIds,
                            err: true,
                            log: 'Unable to run script ' + scriptObj.start,
                            timestamp: new Date().getTime()
                        });
                        if(count === botsScriptDetails.execution.length) {
                            var resultTaskExecution = {
                                "actionStatus": 'failed',
                                "status": 'failed',
                                "endedOn": new Date().getTime(),
                                "actionLogId": actionId
                            };
                            auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                if (err) {
                                    logger.error("Failed to create or update bots Log: ", err);
                                }
                            });
                        }
                    }
                    if(out) {
                        logsDao.insertLog({
                            referenceId: logsReferenceIds,
                            err: false,
                            log: out.toString('ascii'),
                            timestamp: new Date().getTime()
                        });
                    }
                    if(code === 0){
                        count++;
                        logsDao.insertLog({
                            referenceId: logsReferenceIds,
                            err: false,
                            log: 'BOTs execution success for script ' + scriptObj.start,
                            timestamp: new Date().getTime()
                        });
                        if(count === botsScriptDetails.execution.length) {
                            var resultTaskExecution = {
                                "actionStatus": 'success',
                                "status": 'success',
                                "endedOn": new Date().getTime(),
                                "actionLogId": actionId
                            };
                            auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                if (err) {
                                    logger.error("Failed to create or update bots Log: ", err);
                                }
                            });
                        }
                    }
                });
                var botAuditTrailObj = {
                    botId:botsScriptDetails._id,
                    actionId:actionId
                }
                callback(null,botAuditTrailObj);
            });
        })(botsScriptDetails.execution[i])
    }
};

function  executeScriptOnEnv(botsScriptDetails,auditTrail,envId,userName,callback){
    var actionLogId = uuid.v4();
    var count = 0;
    instanceModel.getInstancesByEnvId(envId,userName,function (err,instances) {
        if(err){
            logger.error("Issue with fetching instances which are associated with env. ",envId,err);
            callback(err,null);
            return;
        }else if(instances.length > 0){
            for(var  i = 0; i < instance.length;i++){
                (function(instance){
                    var timestampStarted = new Date().getTime();
                    var actionLog = instanceModel.insertOrchestrationActionLog(instance._id, null, userName, timestampStarted);
                    instance.tempActionLogId = actionLog._id;
                    var logsReferenceIds = [instance._id, actionLog._id,actionLogId];
                    var instanceLog = {
                        actionId: actionLog._id,
                        instanceId: instance._id,
                        orgName: instance.orgName,
                        bgName: instance.bgName,
                        projectName: instance.projectName,
                        envName: instance.environmentName,
                        status: instance.instanceState,
                        actionStatus: "pending",
                        platformId: instance.platformId,
                        blueprintName: instance.blueprintData.blueprintName,
                        data: instance.runlist,
                        platform: instance.hardware.platform,
                        os: instance.hardware.os,
                        size: instance.instanceType,
                        user: userName,
                        createdOn: new Date().getTime(),
                        startedOn: new Date().getTime(),
                        providerType: instance.providerType,
                        action: "BOTs Script-Execution",
                        logs: []
                    };
                    if (!instance.instanceIP) {
                        count++;
                        var timestampEnded = new Date().getTime();
                        logsDao.insertLog({
                            referenceId: logsReferenceIds,
                            err: true,
                            log: "Instance IP is not defined. Chef Client run failed",
                            timestamp: timestampEnded
                        });
                        instanceModel.updateActionLog(instance._id, actionLog._id, false, timestampEnded);
                        instanceLog.endedOn = new Date().getTime();
                        instanceLog.actionStatus = "failed";
                        instanceLog.logs = {
                            err: true,
                            log: "Instance IP is not defined. Chef Client run failed",
                            timestamp: new Date().getTime()
                        };
                        instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function (err, logData) {
                            if (err) {
                                logger.error("Failed to create or update instanceLog: ", err);
                            }
                        });
                        if(count === instances.length) {
                            var resultTaskExecution = {
                                "actionStatus": 'failed',
                                "status": 'failed',
                                "endedOn": new Date().getTime(),
                                "actionLogId": actionLogId
                            };
                            auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                if (err) {
                                    logger.error("Failed to create or update bots Log: ", err);
                                }
                                return;
                            });
                        }
                        return;
                    }
                    credentialCryptography.decryptCredential(instance.credentials, function (err, decryptedCredentials) {
                        var sshOptions = {
                            username: decryptedCredentials.username,
                            host: instance.instanceIP,
                            port: 22
                        }
                        if (decryptedCredentials.pemFileLocation) {
                            sshOptions.privateKey = decryptedCredentials.pemFileLocation;
                        } else {
                            sshOptions.password = decryptedCredentials.password;
                        }

                        var cryptoConfig = appConfig.cryptoSettings;
                        var cryptography = new Cryptography(cryptoConfig.algorithm, cryptoConfig.password);
                        var cmd = null;
                        var gitHubDirPath = appConfig.gitHubDir + botsScriptDetails.gitHubRepoName;
                        var sshExec = new SSHExec(sshOptions);
                        var scp = new SCP(sshOptions);
                        count++;
                        for(var i = 0; i < botsScriptDetails.execution.length; i++) {
                            (function (scriptObj) {
                                fileHound.create()
                                    .paths(gitHubDirPath)
                                    .match(scriptObj.start)
                                    .ext('sh')
                                    .find().then(function (files) {
                                     scp.upload(files[0], '/tmp', function (err) {
                                        if (err) {
                                            var timestampEnded = new Date().getTime();
                                            logsDao.insertLog({
                                                referenceId: logsReferenceIds,
                                                err: true,
                                                log: "Unable to upload script file " + scriptObj.start,
                                                timestamp: timestampEnded
                                            });
                                            instanceModel.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], false, timestampEnded);
                                            instanceLog.endedOn = new Date().getTime();
                                            instanceLog.actionStatus = "failed";
                                            instanceLog.logs = {
                                                err: false,
                                                log: "Unable to upload script file " + script.name,
                                                timestamp: new Date().getTime()
                                            };
                                            instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                if (err) {
                                                    logger.error("Failed to create or update instanceLog: ", err);
                                                }
                                            });
                                            if(count === instances.length) {
                                                var resultTaskExecution = {
                                                    "actionStatus": 'failed',
                                                    "status": 'failed',
                                                    "endedOn": new Date().getTime(),
                                                    "actionLogId": actionLogId
                                                };
                                                auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                    if (err) {
                                                        logger.error("Failed to create or update bots Log: ", err);
                                                    }
                                                    return;
                                                });
                                            }
                                            return;
                                        }
                                         if (scriptObj.sudoFlag && scriptObj.sudoFlag === true) {
                                             cmd = 'sudo ' + scriptObj.type + ' /tmp' + scriptObj.start;
                                         } else {
                                             cmd = scriptObj.type + ' /tmp' + scriptObj.start;
                                         }
                                         if (botsScriptDetails.params.length > 0) {
                                             for (var j = 0; j < botsScriptDetails.params.length; j++) {
                                                 var decryptedText = cryptography.decryptText(botsScriptDetails.params[j], cryptoConfig.decryptionEncoding, cryptoConfig.encryptionEncoding);
                                                 cmd = cmd + ' ' + decryptedText;
                                             }
                                         }
                                        sshExec.exec(cmd, function (err, retCode) {
                                            if (err) {
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    referenceId: logsReferenceIds,
                                                    err: true,
                                                    log: 'Unable to run script ' + scriptObj.start,
                                                    timestamp: timestampEnded
                                                });
                                                instanceModel.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], false, timestampEnded);
                                                instanceLog.endedOn = new Date().getTime();
                                                instanceLog.actionStatus = "failed";
                                                instanceLog.logs = {
                                                    err: false,
                                                    log: 'Unable to run script ' + script.name,
                                                    timestamp: new Date().getTime()
                                                };
                                                instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                                if(count === instances.length) {
                                                    var resultTaskExecution = {
                                                        "actionStatus": 'failed',
                                                        "status": 'failed',
                                                        "endedOn": new Date().getTime(),
                                                        "actionLogId": actionLogId
                                                    };
                                                    auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                        if (err) {
                                                            logger.error("Failed to create or update bots Log: ", err);
                                                        }
                                                        return;
                                                    });
                                                }
                                                return;
                                            }
                                            if (retCode == 0) {
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    referenceId: logsReferenceIds,
                                                    err: false,
                                                    log: 'Task execution success for script ' + scriptObj.start,
                                                    timestamp: timestampEnded
                                                });
                                                instanceModel.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], true, timestampEnded);
                                                instanceLog.endedOn = new Date().getTime();
                                                instanceLog.actionStatus = "success";
                                                instanceLog.logs = {
                                                    err: false,
                                                    log: 'Task execution success for script ' + script.name,
                                                    timestamp: new Date().getTime()
                                                };
                                                instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                                if(count === instances.length) {
                                                    var resultTaskExecution = {
                                                        "actionStatus": 'success',
                                                        "status": 'success',
                                                        "endedOn": new Date().getTime(),
                                                        "actionLogId": actionLogId
                                                    };
                                                    auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                        if (err) {
                                                            logger.error("Failed to create or update bots Log: ", err);
                                                        }
                                                        return;
                                                    });
                                                }
                                                return;
                                            } else {
                                                if (retCode === -5000) {
                                                    logsDao.insertLog({
                                                        referenceId: logsReferenceIds,
                                                        err: true,
                                                        log: 'Host Unreachable',
                                                        timestamp: new Date().getTime()
                                                    });
                                                    instanceLog.endedOn = new Date().getTime();
                                                    instanceLog.actionStatus = "failed";
                                                    instanceLog.logs = {
                                                        err: false,
                                                        log: 'Host Unreachable',
                                                        timestamp: new Date().getTime()
                                                    };
                                                    instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                        if (err) {
                                                            logger.error("Failed to create or update instanceLog: ", err);
                                                        }
                                                    });
                                                    if(count === instances.length) {
                                                        var resultTaskExecution = {
                                                            "actionStatus": 'failed',
                                                            "status": 'failed',
                                                            "endedOn": new Date().getTime(),
                                                            "actionLogId": actionLogId
                                                        };
                                                        auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                            if (err) {
                                                                logger.error("Failed to create or update bots Log: ", err);
                                                            }
                                                            return;
                                                        });
                                                    }
                                                    return;
                                                } else if (retCode === -5001) {
                                                    logsDao.insertLog({
                                                        referenceId: logsReferenceIds,
                                                        err: true,
                                                        log: 'Invalid credentials',
                                                        timestamp: new Date().getTime()
                                                    });
                                                    instanceLog.endedOn = new Date().getTime();
                                                    instanceLog.actionStatus = "failed";
                                                    instanceLog.logs = {
                                                        err: false,
                                                        log: 'Invalid credentials',
                                                        timestamp: new Date().getTime()
                                                    };
                                                    instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                        if (err) {
                                                            logger.error("Failed to create or update instanceLog: ", err);
                                                        }
                                                    });
                                                    if(count === instances.length) {
                                                        var resultTaskExecution = {
                                                            "actionStatus": 'failed',
                                                            "status": 'failed',
                                                            "endedOn": new Date().getTime(),
                                                            "actionLogId": actionLogId
                                                        };
                                                        auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                            if (err) {
                                                                logger.error("Failed to create or update bots Log: ", err);
                                                            }
                                                            return;
                                                        });
                                                    }
                                                    return;
                                                } else {
                                                    logsDao.insertLog({
                                                        referenceId: logsReferenceIds,
                                                        err: true,
                                                        log: 'Unknown error occured. ret code = ' + retCode,
                                                        timestamp: new Date().getTime()
                                                    });
                                                    instanceLog.endedOn = new Date().getTime();
                                                    instanceLog.actionStatus = "failed";
                                                    instanceLog.logs = {
                                                        err: false,
                                                        log: 'Unknown error occured. ret code = ' + retCode,
                                                        timestamp: new Date().getTime()
                                                    };
                                                    instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                        if (err) {
                                                            logger.error("Failed to create or update instanceLog: ", err);
                                                        }
                                                    });
                                                    if(count === instances.length) {
                                                        var resultTaskExecution = {
                                                            "actionStatus": 'failed',
                                                            "status": 'failed',
                                                            "endedOn": new Date().getTime(),
                                                            "actionLogId": actionLogId
                                                        };
                                                        auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                            if (err) {
                                                                logger.error("Failed to create or update bots Log: ", err);
                                                            }
                                                            return;
                                                        });
                                                    }
                                                    return;
                                                }
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    referenceId: logsReferenceIds,
                                                    err: true,
                                                    log: 'Error in running script ' + scriptObj.start,
                                                    timestamp: timestampEnded
                                                });
                                                instanceModel.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], false, timestampEnded);
                                                instanceLog.endedOn = new Date().getTime();
                                                instanceLog.actionStatus = "failed";
                                                instanceLog.logs = {
                                                    err: false,
                                                    log: 'Error in running script ' + script.name,
                                                    timestamp: new Date().getTime()
                                                };
                                                if(count === instances.length) {
                                                    var resultTaskExecution = {
                                                        "actionStatus": 'failed',
                                                        "status": 'failed',
                                                        "endedOn": new Date().getTime(),
                                                        "actionLogId": actionLogId
                                                    };
                                                    auditTrailService.updateAuditTrail('BOTs', auditTrail._id, resultTaskExecution, function (err, data) {
                                                        if (err) {
                                                            logger.error("Failed to create or update bots Log: ", err);
                                                        }
                                                        return;
                                                    });
                                                }
                                                instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                                return;
                                            }
                                        }, function (stdOut) {
                                            logsDao.insertLog({
                                                referenceId: logsReferenceIds,
                                                err: false,
                                                log: stdOut.toString('ascii'),
                                                timestamp: new Date().getTime()
                                            });
                                            instanceLog.logs = {
                                                err: false,
                                                log: stdOut.toString('ascii'),
                                                timestamp: new Date().getTime()
                                            };
                                            instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                if (err) {
                                                    logger.error("Failed to create or update instanceLog: ", err);
                                                }
                                            });
                                        }, function (stdErr) {
                                            logsDao.insertLog({
                                                referenceId: logsReferenceIds,
                                                err: true,
                                                log: stdErr.toString('ascii'),
                                                timestamp: new Date().getTime()
                                            });
                                            instanceLog.logs = {
                                                err: false,
                                                log: stdErr.toString('ascii'),
                                                timestamp: new Date().getTime()
                                            };
                                            instanceLogModel.createOrUpdate(logsReferenceIds[1], logsReferenceIds[0], instanceLog, function (err, logData) {
                                                if (err) {
                                                    logger.error("Failed to create or update instanceLog: ", err);
                                                }
                                            });
                                        });
                                    })
                                    var botAuditTrailObj = {
                                        botId:botsScriptDetails._id,
                                        actionId:actionLogId
                                    }
                                    callback(null,botAuditTrailObj);
                                })
                            })(botsScriptDetails.execution[i])
                        }
                    });
                })(instances[i]);
            }
        }else{
            logger.debug("There is no instance which is associated with env. ",envId);
            callback(null,instances);
            return;
        }
    })

}










