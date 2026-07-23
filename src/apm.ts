import dotenv from 'dotenv';
import apm from 'elastic-apm-node';

dotenv.config();

const explicitlyActive = (process.env.ELASTIC_APM_ACTIVE ?? '').toLowerCase() === 'true';
const hasServerUrl = !!(process.env.ELASTIC_APM_SERVER_URL ?? '').trim();

if ((explicitlyActive || hasServerUrl) && !apm.isStarted()) {
  apm.start({
    serviceName: process.env.ELASTIC_APM_SERVICE_NAME || 'whatsapp-api',
    environment: process.env.ELASTIC_APM_ENVIRONMENT || process.env.NODE_ENV || 'development',
  });
}

export default apm;
