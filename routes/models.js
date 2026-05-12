const express = require('express');
const formidable = require('express-formidable');
const { APS_BUCKET } = require('../config.js');
const { listObjects, uploadObject, createSignedResource, deleteObject, translateObject, getManifest, urnify } = require('../services/aps.js');
const { decodeObjectName, encodeObjectName } = require('../services/modelNames.js');
const logger = require('../services/logger.js');

function parseObjectName(urn) {
    const padded = urn + '='.repeat((4 - urn.length % 4) % 4);
    const objectId = Buffer.from(padded, 'base64').toString('utf8');
    const prefix = `urn:adsk.objects:os.object:${APS_BUCKET}/`;
    if (!objectId.startsWith(prefix)) {
        const error = new Error('URN does not belong to the current bucket.');
        error.status = 400;
        throw error;
    }
    const raw = objectId.substring(prefix.length);
    try {
        return decodeURIComponent(raw);
    } catch (_err) {
        return raw;
    }
}

let router = express.Router();

router.get('/api/models', async function (req, res, next) {
    try {
        logger.info('DRAWING_LOAD', '도면 목록 조회 시작');
        const objects = await listObjects();
        logger.info('DRAWING_LOAD', '도면 목록 조회 완료', { count: objects.length });
        res.json(objects.map(o => ({
            name: decodeObjectName(o.objectKey),
            urn: urnify(o.objectId)
        })));
    } catch (err) {
        logger.error('DRAWING_LOAD', '도면 목록 조회 실패', { message: err.message });
        next(err);
    }
});

router.get('/api/models/:urn/status', async function (req, res, next) {
    try {
        logger.info('DRAWING_LOAD', '도면 변환 상태 조회 시작', { urn: req.params.urn });
        const manifest = await getManifest(req.params.urn);
        if (manifest) {
            let messages = [];
            if (manifest.derivatives) {
                for (const derivative of manifest.derivatives) {
                    messages = messages.concat(derivative.messages || []);
                    if (derivative.children) {
                        for (const child of derivative.children) {
                            messages.concat(child.messages || []);
                        }
                    }
                }
            }
            logger.info('DRAWING_LOAD', '도면 변환 상태 조회 완료', { urn: req.params.urn, status: manifest.status, progress: manifest.progress });
            res.json({ status: manifest.status, progress: manifest.progress, messages });
        } else {
            logger.info('DRAWING_LOAD', '도면 변환 상태 없음', { urn: req.params.urn });
            res.json({ status: 'n/a' });
        }
    } catch (err) {
        logger.error('DRAWING_LOAD', '도면 변환 상태 조회 실패', { urn: req.params.urn, message: err.message });
        next(err);
    }
});

router.post('/api/models', formidable({ maxFileSize: Infinity }), async function (req, res, next) {
    const file = req.files['model-file'];
    if (!file) {
        res.status(400).send('The required field ("model-file") is missing.');
        return;
    }
    try {
        const objectName = encodeObjectName(file.name);
        logger.info('DRAWING_LOAD', '도면 업로드 시작', { fileName: file.name, objectName });
        const obj = await uploadObject(objectName, file.path);
        logger.info('DRAWING_LOAD', '도면 업로드 완료', { objectId: obj.objectId, objectKey: obj.objectKey });
        logger.info('DRAWING_LOAD', '도면 변환 요청 시작', { urn: urnify(obj.objectId), rootFilename: req.fields['model-zip-entrypoint'] });
        await translateObject(urnify(obj.objectId), req.fields['model-zip-entrypoint']);
        logger.info('DRAWING_LOAD', '도면 변환 요청 완료', { urn: urnify(obj.objectId) });
        res.json({
            name: decodeObjectName(obj.objectKey),
            urn: urnify(obj.objectId)
        });
    } catch (err) {
        logger.error('DRAWING_LOAD', '도면 업로드 또는 변환 요청 실패', { fileName: file.name, message: err.message });
        next(err);
    }
});

router.get('/api/models/:urn/download', async function (req, res, next) {
    try {
        logger.info('DRAWING_LOAD', '도면 다운로드 요청 시작', { urn: req.params.urn });
        const objectName = parseObjectName(req.params.urn);
        const fileName = decodeObjectName(objectName);
        const signedUrl = await createSignedResource(objectName);
        logger.info('DRAWING_LOAD', '도면 다운로드 signed URL 생성 완료', { objectName, fileName });
        res.redirect(signedUrl);
    } catch (err) {
        logger.error('DRAWING_LOAD', '도면 다운로드 실패', { urn: req.params.urn, message: err.message });
        if (err.status === 400) {
            res.status(400).send(err.message);
            return;
        }
        next(err);
    }
});

router.delete('/api/models/:urn', async function (req, res, next) {
    try {
        logger.info('DRAWING_DELETE', '도면 삭제 요청 시작', { urn: req.params.urn });
        const objectName = parseObjectName(req.params.urn);
        logger.info('DRAWING_DELETE', '도면 삭제 대상 파싱 완료', { objectName });
        await deleteObject(objectName);
        logger.info('DRAWING_DELETE', '도면 삭제 완료', { objectName });
        res.json({
            name: decodeObjectName(objectName),
            urn: req.params.urn
        });
    } catch (err) {
        logger.error('DRAWING_DELETE', '도면 삭제 실패', { urn: req.params.urn, message: err.message });
        if (err.status === 400) {
            res.status(400).send(err.message);
            return;
        }
        next(err);
    }
});

module.exports = router;
