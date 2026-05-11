function encodeObjectName(displayName) {
    return encodeURIComponent(displayName);
}

function decodeObjectName(objectName) {
    try {
        return decodeURIComponent(objectName);
    } catch (_err) {
        return objectName;
    }
}

function createEditedObjectName(inputObjectName) {
    const extension = getExtension(inputObjectName);
    const baseName = extension ? inputObjectName.substring(0, inputObjectName.length - extension.length) : inputObjectName;
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').substring(0, 14);
    return `${baseName}_edited_${timestamp}${extension || '.dwg'}`;
}

function getExtension(name) {
    const dotIndex = name.lastIndexOf('.');
    return dotIndex === -1 ? '' : name.substring(dotIndex);
}

module.exports = {
    decodeObjectName,
    encodeObjectName,
    createEditedObjectName
};
