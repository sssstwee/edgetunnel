import bundledPolicy from '../jms-config/clash-base.yaml';
import { createUnifiedWorker } from './worker.mjs';

// The unified profile routes with the same template as JMS Remote and GCP Remote.
export default createUnifiedWorker(bundledPolicy);
