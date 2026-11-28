import bundledPolicy from '../jms-config/clash-base.yaml';
import { createUnifiedWorker } from './worker.mjs';

// The unified profile builds on the JMS/GCP template with unified-only Google exceptions.
export default createUnifiedWorker(bundledPolicy);
