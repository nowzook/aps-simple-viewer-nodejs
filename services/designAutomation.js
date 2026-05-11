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

function createScript({ handle, mode, x, y, angle, rotationBaseX, rotationBaseY }) {
    const safeHandle = String(handle || '').replace(/[^0-9A-Z]/gi, '');
    const moveMode = mode === 'absolute' ? 'absolute' : 'relative';
    const moveX = Number.isFinite(Number(x)) ? Number(x) : 0;
    const moveY = Number.isFinite(Number(y)) ? Number(y) : 0;
    const rotateAngle = Number.isFinite(Number(angle)) ? Number(angle) : 0;
    const baseX = Number.isFinite(Number(rotationBaseX)) ? Number(rotationBaseX) : 0;
    const baseY = Number.isFinite(Number(rotationBaseY)) ? Number(rotationBaseY) : 0;

    return [
        '(vl-load-com)',
        '(setq ent (handent "' + safeHandle.toUpperCase() + '"))',
        '(if ent',
        '  (progn',
        '    (setq obj (vlax-ename->vla-object ent))',
        '    (setq doc (vla-get-document obj))',
        moveMode === 'absolute'
            ? `    (setq bboxMin (vlax-make-safearray vlax-vbDouble '(0 . 2)))`
            : '    (setq moveFrom (vlax-3d-point 0 0 0))',
        moveMode === 'absolute'
            ? `    (setq bboxMax (vlax-make-safearray vlax-vbDouble '(0 . 2)))`
            : `    (setq moveTo (vlax-3d-point ${moveX} ${moveY} 0))`,
        moveMode === 'absolute'
            ? '    (vla-getboundingbox obj \'bboxMin \'bboxMax)'
            : '    (vla-move obj moveFrom moveTo)',
        moveMode === 'absolute'
            ? '    (setq minPt (vlax-safearray->list bboxMin))'
            : '',
        moveMode === 'absolute'
            ? '    (setq maxPt (vlax-safearray->list bboxMax))'
            : '',
        moveMode === 'absolute'
            ? '    (setq currentX (/ (+ (car minPt) (car maxPt)) 2.0))'
            : '',
        moveMode === 'absolute'
            ? '    (setq currentY (/ (+ (cadr minPt) (cadr maxPt)) 2.0))'
            : '',
        moveMode === 'absolute'
            ? `    (setq moveFrom (vlax-3d-point currentX currentY 0))`
            : '',
        moveMode === 'absolute'
            ? `    (setq moveTo (vlax-3d-point ${moveX} ${moveY} 0))`
            : '',
        moveMode === 'absolute'
            ? '    (vla-move obj moveFrom moveTo)'
            : '',
        rotateAngle
            ? `    (vla-rotate obj (vlax-3d-point ${baseX} ${baseY} 0) (* pi (/ ${rotateAngle} 180.0)))`
            : '',
        '    (vla-update obj)',
        '    (entupd ent)',
        '    (vla-regen doc 1)',
        '    (vla-saveas doc (strcat (getvar "DWGPREFIX") "output.dwg"))',
        '  )',
        ')',
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
