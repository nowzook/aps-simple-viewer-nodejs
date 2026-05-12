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
    const editMatch = baseName.match(/^(.*_edited_\d{14})(?:\((\d+)\))?$/);
    if (editMatch) {
        const nextIndex = Number(editMatch[2] || 0) + 1;
        return `${editMatch[1]}(${nextIndex})${extension || '.dwg'}`;
    }
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
