const {
    AutodeskForgeDesignAutomationApi,
    AutodeskForgeDesignAutomationClient,
    Verb
} = require('autodesk.forge.designautomation');
const { Access } = require('@aps_sdk/oss');
const { APS_CLIENT_ID, APS_DESIGN_AUTOMATION_NICKNAME } = require('../config.js');
const { createSignedResource, getInternalToken } = require('./aps.js');

const ACTIVITY_ID = 'DwgObjectTransform';
const ACTIVITY_ALIAS = 'dev';
const ACTIVITY_ENGINE = 'Autodesk.AutoCAD+25_0';

let designAutomationClient = null;

function getNickname() {
    return APS_DESIGN_AUTOMATION_NICKNAME || APS_CLIENT_ID;
}

async function getDesignAutomationApi() {
    if (!designAutomationClient) {
        designAutomationClient = new AutodeskForgeDesignAutomationClient();
        const fetchToken = async () => {
            const accessToken = await getInternalToken();
            return {
                access_token: accessToken,
                expires_in: 3599
            };
        };
        designAutomationClient.authManager.authentications['2-legged'].fetchToken = fetchToken;
        designAutomationClient.authManager.authentications['2-legged'].refreshToken = fetchToken;
    }
    return new AutodeskForgeDesignAutomationApi(designAutomationClient);
}

function getQualifiedActivityId() {
    return `${getNickname()}.${ACTIVITY_ID}+${ACTIVITY_ALIAS}`;
}

function createScript({ handle, mode, x, y, angle, rotationBaseX, rotationBaseY, moveDeltaX, moveDeltaY }) {
    const safeHandle = String(handle || '').replace(/[^0-9A-Z]/gi, '');
    const moveMode = mode === 'absolute' ? 'absolute' : 'relative';
    const moveX = Number.isFinite(Number(x)) ? Number(x) : 0;
    const moveY = Number.isFinite(Number(y)) ? Number(y) : 0;
    const rotateAngle = Number.isFinite(Number(angle)) ? Number(angle) : 0;
    const baseX = Number.isFinite(Number(rotationBaseX)) ? Number(rotationBaseX) : 0;
    const baseY = Number.isFinite(Number(rotationBaseY)) ? Number(rotationBaseY) : 0;
    const deltaX = Number.isFinite(Number(moveDeltaX)) ? Number(moveDeltaX) : moveMode === 'absolute' ? moveX - baseX : moveX;
    const deltaY = Number.isFinite(Number(moveDeltaY)) ? Number(moveDeltaY) : moveMode === 'absolute' ? moveY - baseY : moveY;
    const shouldMove = deltaX !== 0 || deltaY !== 0;
    const shouldRotate = rotateAngle !== 0;
    const shouldChange = shouldMove || shouldRotate;

    return [
        '(setq ent (handent "' + safeHandle.toUpperCase() + '"))',
        '(if (not ent) (vl-exit-with-error "DWG_EDIT_ENTITY_NOT_FOUND"))',
        shouldChange ? '(setq before (entget ent))' : '',
        '(setq ss (ssadd ent))',
        shouldMove
            ? `(command "_.MOVE" ss "" (list 0 0 0) (list ${deltaX} ${deltaY} 0))`
            : '',
        shouldRotate
            ? `(command "_.ROTATE" ss "" (list ${baseX} ${baseY} 0) ${rotateAngle})`
            : '',
        shouldChange ? '(setq after (entget ent))' : '',
        shouldChange ? '(if (equal before after) (vl-exit-with-error "DWG_EDIT_ENTITY_UNCHANGED"))' : '',
        '_.REGEN',
        '_.SAVEAS',
        '2018',
        'output.dwg',
        '_QUIT'
    ].filter(Boolean).join('\n') + '\n';
}

async function ensureActivity() {
    const api = await getDesignAutomationApi();
    try {
        await api.getActivityAlias(ACTIVITY_ID, ACTIVITY_ALIAS);
        return getQualifiedActivityId();
    } catch (err) {
        if (!String(err?.status || err?.response?.status || err?.message).includes('404')) {
            throw err;
        }
    }

    const activity = {
        id: ACTIVITY_ID,
        commandLine: [
            '$(engine.path)\\accoreconsole.exe /i "$(args[inputFile].path)" /s "$(settings[script].path)" /suppressGraphics'
        ],
        engine: ACTIVITY_ENGINE,
        parameters: {
            inputFile: {
                verb: Verb.get,
                description: 'Source DWG',
                required: true,
                localName: 'input.dwg'
            },
            outputFile: {
                verb: Verb.put,
                description: 'Edited DWG',
                required: true,
                localName: 'output.dwg'
            }
        },
        settings: {
            script: {
                value: 'QSAVE\nQUIT\n'
            }
        },
        description: 'Moves and rotates a DWG entity by handle.'
    };

    let version = 1;
    try {
        const created = await api.createActivity(activity);
        version = created.version || 1;
    } catch (err) {
        if (!String(err?.status || err?.response?.status || err?.message).includes('409')) {
            throw err;
        }
        const created = await api.createActivityVersion(ACTIVITY_ID, activity);
        version = created.version || 1;
    }
    await api.createActivityAlias(ACTIVITY_ID, {
        id: ACTIVITY_ALIAS,
        version
    });
    return getQualifiedActivityId();
}

async function runDwgTransform({ inputObjectName, outputObjectName, transform }) {
    const api = await getDesignAutomationApi();
    const activityId = await ensureActivity();
    const accessToken = await getInternalToken();
    const inputUrl = await createSignedResource(inputObjectName, Access.Read);
    const outputUrl = await createSignedResource(outputObjectName, Access.ReadWrite);
    const script = createScript(transform);
    const workItem = {
        activityId,
        arguments: {
            inputFile: {
                url: inputUrl,
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            },
            outputFile: {
                url: outputUrl,
                verb: Verb.put,
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        },
        limitProcessingTimeSec: 900
    };
    const activity = {
        commandLine: [
            '$(engine.path)\\accoreconsole.exe /i "$(args[inputFile].path)" /s "$(settings[script].path)" /suppressGraphics'
        ],
        engine: ACTIVITY_ENGINE,
        parameters: {
            inputFile: {
                verb: Verb.get,
                description: 'Source DWG',
                required: true,
                localName: 'input.dwg'
            },
            outputFile: {
                verb: Verb.put,
                description: 'Edited DWG',
                required: true,
                localName: 'output.dwg'
            }
        },
        settings: {
            script: {
                value: script
            }
        }
    };
    const updatedActivity = await api.createActivityVersion(ACTIVITY_ID, activity);
    await api.modifyActivityAlias(ACTIVITY_ID, ACTIVITY_ALIAS, {
        version: updatedActivity.version
    });
    const status = await api.createWorkItem(workItem);
    return status;
}

async function getWorkItemStatus(workItemId) {
    const api = await getDesignAutomationApi();
    return await api.getWorkitemStatus(workItemId);
}

module.exports = {
    getWorkItemStatus,
    runDwgTransform
};
