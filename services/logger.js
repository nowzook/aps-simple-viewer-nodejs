const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logsDir, 'server.log');

function ensureLogsDir() {
    fs.mkdirSync(logsDir, { recursive: true });
}

function serializeDetails(details) {
    if (!details) {
        return '';
    }
    return ` ${JSON.stringify(details)}`;
}

function write(level, area, message, details) {
    ensureLogsDir();
    const line = `[${new Date().toISOString()}] [${level}] [${area}] ${message}${serializeDetails(details)}`;
    fs.appendFileSync(logFile, `${line}\n`);
    console.log(line);
}

module.exports = {
    info(area, message, details) {
        write('INFO', area, message, details);
    },
    error(area, message, details) {
        write('ERROR', area, message, details);
    },
    logFile
};
