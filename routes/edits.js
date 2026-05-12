const express = require('express');
const { APS_BUCKET } = require('../config.js');
const { runDwgTransform, getWorkItemStatus } = require('../services/designAutomation.js');
const { translateObject, urnify } = require('../services/aps.js');
const { createEditedObjectName, decodeObjectName } = require('../services/modelNames.js');
const logger = require('../services/logger.js');

function parseObjectId(urn) {
    const padded = urn + '='.repeat((4 - urn.length % 4) % 4);
    const objectId = Buffer.from(padded, 'base64').toString('utf8');
    const prefix = 'urn:adsk.objects:os.object:';
    if (!objectId.startsWith(prefix)) {
        throw new Error('Unsupported model URN.');
    }
    const objectPath = objectId.substring(prefix.length);
    const slashIndex = objectPath.indexOf('/');
    if (slashIndex === -1) {
        throw new Error('Could not parse object key from model URN.');
    }
    const objectName = objectPath.substring(slashIndex + 1);
    return {
        objectId,
        objectName: decodeObjectName(objectName)
    };
}

function validateTransform(body) {
    const handle = String(body?.handle || '').replace(/[^0-9A-Z]/gi, '');
    if (!handle) {
        const err = new Error('DWG entity handle is required.');
        err.status = 400;
        throw err;
    }
    return {
        handle,
        mode: body.mode === 'absolute' ? 'absolute' : 'relative',
        x: normalizeNumber(body.x),
        y: normalizeNumber(body.y),
        angle: normalizeNumber(body.angle),
        rotationBaseX: normalizeNumber(body.rotationBaseX),
        rotationBaseY: normalizeNumber(body.rotationBaseY),
        moveDeltaX: normalizeOptionalNumber(body.moveDeltaX),
        moveDeltaY: normalizeOptionalNumber(body.moveDeltaY)
    };
}

function normalizeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeOptionalNumber(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

const router = express.Router();
const edits = new Map();

router.use(express.json());

router.post('/api/models/:urn/edits', async function (req, res, next) {
    try {
        logger.info('DRAWING_EDIT', '편집 요청 수신', { urn: req.params.urn });
        const transform = validateTransform(req.body);
        logger.info('DRAWING_EDIT', '편집 입력값 검증 완료', transform);
        const { objectName } = parseObjectId(req.params.urn);
        logger.info('DRAWING_EDIT', '편집 대상 도면 파싱 완료', { objectName });
        const outputObjectName = createEditedObjectName(objectName);
        logger.info('DRAWING_EDIT', '편집 결과 도면 이름 생성 완료', { outputObjectName });
        const status = await runDwgTransform({
            inputObjectName: objectName,
            outputObjectName,
            transform
        });
        logger.info('DRAWING_EDIT', '편집 WorkItem 생성 완료', { workItemId: status.id, status: status.status });
        edits.set(status.id, {
            outputObjectName,
            translated: false
        });
        res.json({
            workItemId: status.id,
            status: status.status
        });
    } catch (err) {
        logger.error('DRAWING_EDIT', '편집 요청 처리 실패', { urn: req.params.urn, message: err.message });
        next(err);
    }
});

router.get('/api/edits/:workItemId', async function (req, res, next) {
    try {
        logger.info('DRAWING_EDIT', '편집 상태 조회 시작', { workItemId: req.params.workItemId });
        const edit = edits.get(req.params.workItemId);
        if (!edit) {
            logger.error('DRAWING_EDIT', '알 수 없는 편집 WorkItem', { workItemId: req.params.workItemId });
            res.status(404).send('Unknown edit work item.');
            return;
        }
        const status = await getWorkItemStatus(req.params.workItemId);
        logger.info('DRAWING_EDIT', '편집 상태 조회 완료', { workItemId: req.params.workItemId, status: status.status, progress: status.progress });
        const response = {
            workItemId: req.params.workItemId,
            status: status.status,
            progress: status.progress,
            reportUrl: status.reportUrl
        };
        if (status.status === 'success') {
            const outputObjectId = `urn:adsk.objects:os.object:${APS_BUCKET}/${encodeURIComponent(edit.outputObjectName)}`;
            const urn = urnify(outputObjectId);
            if (!edit.translated) {
                logger.info('DRAWING_EDIT', '편집 결과 도면 변환 요청 시작', { workItemId: req.params.workItemId, urn });
                await translateObject(urn);
                edit.translated = true;
                logger.info('DRAWING_EDIT', '편집 결과 도면 변환 요청 완료', { workItemId: req.params.workItemId, urn });
            }
            response.model = {
                name: decodeObjectName(edit.outputObjectName),
                urn
            };
        }
        res.json(response);
    } catch (err) {
        logger.error('DRAWING_EDIT', '편집 상태 조회 실패', { workItemId: req.params.workItemId, message: err.message });
        next(err);
    }
});

module.exports = router;
