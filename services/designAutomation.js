const {
    AutodeskForgeDesignAutomationApi,
    AutodeskForgeDesignAutomationClient,
    Verb
} = require('autodesk.forge.designautomation');
const { Access } = require('@aps_sdk/oss');
const { APS_CLIENT_ID, APS_DESIGN_AUTOMATION_NICKNAME } = require('../config.js');
const { createSignedResource, getInternalToken } = require('./aps.js');
const logger = require('./logger.js');

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

function formatLispNumber(n) {
    if (!Number.isFinite(n)) return '0.0';
    const s = String(n);
    return s.indexOf('.') === -1 && s.indexOf('e') === -1 ? `${s}.0` : s;
}

function createScript(transform) {
    if (transform.operation === 'delete') {
        return createDeleteScript(transform);
    }
    if (transform.operation === 'copy') {
        return createCopyScript(transform);
    }
    return createTransformScript(transform);
}

function createDeleteScript({ handle }) {
    const safeHandle = String(handle || '').replace(/[^0-9A-Z]/gi, '');
    const handleUpper = safeHandle.toUpperCase();
    const lispLines = [
        `(setq ent (handent "${handleUpper}"))`,
        '(if (not ent) (vl-exit-with-error "DWG_EDIT_ENTITY_NOT_FOUND"))',
        '(if (not (entdel ent)) (vl-exit-with-error "DWG_EDIT_DELETE_FAILED"))',
        '_.REGEN',
        '_.SAVEAS',
        '2018',
        'output.dwg',
        '_QUIT'
    ];
    return lispLines.join('\n') + '\n';
}

function createCopyScript({ handle, mode, x, y, angle, rotationBaseX, rotationBaseY, moveDeltaX, moveDeltaY }) {
    const safeHandle = String(handle || '').replace(/[^0-9A-Z]/gi, '');
    const moveMode = mode === 'absolute' ? 'absolute' : 'relative';
    const moveX = Number.isFinite(Number(x)) ? Number(x) : 0;
    const moveY = Number.isFinite(Number(y)) ? Number(y) : 0;
    const rotateAngle = Number.isFinite(Number(angle)) ? Number(angle) : 0;
    const baseX = Number.isFinite(Number(rotationBaseX)) ? Number(rotationBaseX) : 0;
    const baseY = Number.isFinite(Number(rotationBaseY)) ? Number(rotationBaseY) : 0;
    const deltaX = Number.isFinite(Number(moveDeltaX)) ? Number(moveDeltaX) : moveMode === 'absolute' ? moveX - baseX : moveX;
    const deltaY = Number.isFinite(Number(moveDeltaY)) ? Number(moveDeltaY) : moveMode === 'absolute' ? moveY - baseY : moveY;
    const shouldRotate = rotateAngle !== 0;

    const handleUpper = safeHandle.toUpperCase();
    const dxFmt = formatLispNumber(deltaX);
    const dyFmt = formatLispNumber(deltaY);
    const cxFmt = formatLispNumber(baseX);
    const cyFmt = formatLispNumber(baseY);
    const aFmt = formatLispNumber(rotateAngle);
    const lispLines = [
        `(setq ent (handent "${handleUpper}"))`,
        '(if (not ent) (vl-exit-with-error "DWG_EDIT_ENTITY_NOT_FOUND"))',
        '(setq data (entget ent))',
        `(setq dx ${dxFmt})`,
        `(setq dy ${dyFmt})`,
        `(setq cx ${cxFmt})`,
        `(setq cy ${cyFmt})`,
        `(setq rad (* ${aFmt} (/ pi 180.0)))`
    ];

    lispLines.push('(defun transform-point (pt / px py pz rpx rpy)');
    lispLines.push('  (setq px (car pt)) (setq py (cadr pt))');
    lispLines.push('  (setq pz (if (caddr pt) (caddr pt) 0.0))');
    if (shouldRotate) {
        lispLines.push('  (setq rpx (+ cx (- (* (- px cx) (cos rad)) (* (- py cy) (sin rad)))))');
        lispLines.push('  (setq rpy (+ cy (+ (* (- px cx) (sin rad)) (* (- py cy) (cos rad)))))');
        lispLines.push('  (setq px rpx) (setq py rpy)');
    }
    lispLines.push('  (setq px (+ px dx)) (setq py (+ py dy))');
    lispLines.push('  (list px py pz))');

    lispLines.push('(setq newdata (mapcar');
    lispLines.push('  (function (lambda (e)');
    lispLines.push('    (cond');
    lispLines.push('      ((or (= (car e) -1) (= (car e) 5) (= (car e) 330) (= (car e) 360) (= (car e) 102)) nil)');
    lispLines.push('      ((or (= (car e) 10) (= (car e) 11)) (cons (car e) (transform-point (cdr e))))');
    if (shouldRotate) {
        lispLines.push('      ((= (car e) 50) (cons 50 (+ (cdr e) rad)))');
    }
    lispLines.push('      (t e))))');
    lispLines.push('  data))');
    lispLines.push('(setq newdata (vl-remove nil newdata))');
    lispLines.push('(if (not (entmakex newdata)) (vl-exit-with-error "DWG_EDIT_COPY_FAILED"))');
    lispLines.push('_.REGEN');
    lispLines.push('_.SAVEAS');
    lispLines.push('2018');
    lispLines.push('output.dwg');
    lispLines.push('_QUIT');
    return lispLines.join('\n') + '\n';
}

function createTransformScript({ handle, mode, x, y, angle, rotationBaseX, rotationBaseY, moveDeltaX, moveDeltaY }) {
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

    const handleUpper = safeHandle.toUpperCase();
    const dxFmt = formatLispNumber(deltaX);
    const dyFmt = formatLispNumber(deltaY);
    const cxFmt = formatLispNumber(baseX);
    const cyFmt = formatLispNumber(baseY);
    const aFmt = formatLispNumber(rotateAngle);
    const lispLines = [
        `(setq ent (handent "${handleUpper}"))`,
        '(if (not ent) (vl-exit-with-error "DWG_EDIT_ENTITY_NOT_FOUND"))',
        '(setq data (entget ent))',
        `(setq dx ${dxFmt})`,
        `(setq dy ${dyFmt})`,
        `(setq cx ${cxFmt})`,
        `(setq cy ${cyFmt})`,
        `(setq rad (* ${aFmt} (/ pi 180.0)))`
    ];

    lispLines.push('(defun transform-point (pt / px py pz rpx rpy)');
    lispLines.push('  (setq px (car pt)) (setq py (cadr pt))');
    lispLines.push('  (setq pz (if (caddr pt) (caddr pt) 0.0))');
    if (shouldRotate) {
        lispLines.push('  (setq rpx (+ cx (- (* (- px cx) (cos rad)) (* (- py cy) (sin rad)))))');
        lispLines.push('  (setq rpy (+ cy (+ (* (- px cx) (sin rad)) (* (- py cy) (cos rad)))))');
        lispLines.push('  (setq px rpx) (setq py rpy)');
    }
    if (shouldMove) {
        lispLines.push('  (setq px (+ px dx)) (setq py (+ py dy))');
    }
    lispLines.push('  (list px py pz))');

    lispLines.push('(setq newdata (mapcar');
    lispLines.push('  (function (lambda (e)');
    lispLines.push('    (cond');
    lispLines.push('      ((or (= (car e) 10) (= (car e) 11)) (cons (car e) (transform-point (cdr e))))');
    if (shouldRotate) {
        lispLines.push('      ((= (car e) 50) (cons 50 (+ (cdr e) rad)))');
    }
    lispLines.push('      (t e))))');
    lispLines.push('  data))');

    lispLines.push('(if (equal data newdata) (vl-exit-with-error "DWG_EDIT_ENTITY_UNCHANGED"))');
    lispLines.push('(if (not (entmod newdata)) (vl-exit-with-error "DWG_EDIT_ENTMOD_FAILED"))');
    lispLines.push('(entupd ent)');
    lispLines.push('_.REGEN');
    lispLines.push('_.SAVEAS');
    lispLines.push('2018');
    lispLines.push('output.dwg');
    lispLines.push('_QUIT');
    return lispLines.join('\n') + '\n';
}

async function ensureActivity() {
    const api = await getDesignAutomationApi();
    try {
        logger.info('DRAWING_EDIT', 'Design Automation Activity alias 확인 시작', { activityId: ACTIVITY_ID, alias: ACTIVITY_ALIAS });
        await api.getActivityAlias(ACTIVITY_ID, ACTIVITY_ALIAS);
        logger.info('DRAWING_EDIT', 'Design Automation Activity alias 확인 완료', { qualifiedActivityId: getQualifiedActivityId() });
        return getQualifiedActivityId();
    } catch (err) {
        if (!String(err?.status || err?.response?.status || err?.message).includes('404')) {
            logger.error('DRAWING_EDIT', 'Design Automation Activity alias 확인 실패', { message: err.message });
            throw err;
        }
        logger.info('DRAWING_EDIT', 'Design Automation Activity alias 없음, 새로 생성 진행', { activityId: ACTIVITY_ID, alias: ACTIVITY_ALIAS });
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
        logger.info('DRAWING_EDIT', 'Design Automation Activity 생성 시작', { activityId: ACTIVITY_ID });
        const created = await api.createActivity(activity);
        version = created.version || 1;
        logger.info('DRAWING_EDIT', 'Design Automation Activity 생성 완료', { activityId: ACTIVITY_ID, version });
    } catch (err) {
        if (!String(err?.status || err?.response?.status || err?.message).includes('409')) {
            logger.error('DRAWING_EDIT', 'Design Automation Activity 생성 실패', { activityId: ACTIVITY_ID, message: err.message });
            throw err;
        }
        logger.info('DRAWING_EDIT', 'Design Automation Activity 기존 항목 감지, 새 버전 생성 시작', { activityId: ACTIVITY_ID });
        const created = await api.createActivityVersion(ACTIVITY_ID, activity);
        version = created.version || 1;
        logger.info('DRAWING_EDIT', 'Design Automation Activity 새 버전 생성 완료', { activityId: ACTIVITY_ID, version });
    }
    logger.info('DRAWING_EDIT', 'Design Automation Activity alias 생성 시작', { activityId: ACTIVITY_ID, alias: ACTIVITY_ALIAS, version });
    await api.createActivityAlias(ACTIVITY_ID, {
        id: ACTIVITY_ALIAS,
        version
    });
    logger.info('DRAWING_EDIT', 'Design Automation Activity alias 생성 완료', { qualifiedActivityId: getQualifiedActivityId(), version });
    return getQualifiedActivityId();
}

async function runDwgTransform({ inputObjectName, outputObjectName, transform }) {
    logger.info('DRAWING_EDIT', '편집 실행 준비 시작', { inputObjectName, outputObjectName });
    const api = await getDesignAutomationApi();
    logger.info('DRAWING_EDIT', 'Design Automation API 준비 완료');
    const activityId = await ensureActivity();
    logger.info('DRAWING_EDIT', '편집 Activity 준비 완료', { activityId });
    const accessToken = await getInternalToken();
    logger.info('DRAWING_EDIT', '편집용 내부 토큰 발급 완료');
    const inputUrl = await createSignedResource(inputObjectName, Access.Read);
    logger.info('DRAWING_EDIT', '편집 입력 도면 signed URL 생성 완료', { inputObjectName });
    const outputUrl = await createSignedResource(outputObjectName, Access.ReadWrite);
    logger.info('DRAWING_EDIT', '편집 결과 도면 signed URL 생성 완료', { outputObjectName });
    const script = createScript(transform);
    logger.info('DRAWING_EDIT', '편집 AutoLISP 스크립트 생성 완료', { handle: transform.handle, operation: transform.operation, mode: transform.mode });
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
    logger.info('DRAWING_EDIT', '편집 Activity 새 버전 생성 시작', { activityId: ACTIVITY_ID });
    const updatedActivity = await api.createActivityVersion(ACTIVITY_ID, activity);
    logger.info('DRAWING_EDIT', '편집 Activity 새 버전 생성 완료', { activityId: ACTIVITY_ID, version: updatedActivity.version });
    logger.info('DRAWING_EDIT', '편집 Activity alias 갱신 시작', { activityId: ACTIVITY_ID, alias: ACTIVITY_ALIAS, version: updatedActivity.version });
    await api.modifyActivityAlias(ACTIVITY_ID, ACTIVITY_ALIAS, {
        version: updatedActivity.version
    });
    logger.info('DRAWING_EDIT', '편집 Activity alias 갱신 완료', { qualifiedActivityId: activityId, version: updatedActivity.version });
    logger.info('DRAWING_EDIT', '편집 WorkItem 제출 시작', { inputObjectName, outputObjectName });
    const status = await api.createWorkItem(workItem);
    logger.info('DRAWING_EDIT', '편집 WorkItem 제출 완료', { workItemId: status.id, status: status.status });
    return status;
}

async function getWorkItemStatus(workItemId) {
    const api = await getDesignAutomationApi();
    logger.info('DRAWING_EDIT', 'Design Automation WorkItem 상태 API 호출 시작', { workItemId });
    const status = await api.getWorkitemStatus(workItemId);
    logger.info('DRAWING_EDIT', 'Design Automation WorkItem 상태 API 호출 완료', { workItemId, status: status.status, progress: status.progress });
    return status;
}

module.exports = {
    getWorkItemStatus,
    runDwgTransform
};
