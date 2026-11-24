import bundledPolicy from '../jms-config/clash-base.yaml';
import { createGcpWorker } from './worker.mjs';

// GCP Remote ships the JMS Remote template itself, so both subscriptions route identically.
export default createGcpWorker(bundledPolicy);
