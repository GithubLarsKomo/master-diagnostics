import {
  attestGlobalPrivacyCapabilitiesFromEnvironment,
} from './services/global-privacy-capability-env';

const attestation = attestGlobalPrivacyCapabilitiesFromEnvironment(process.env);
const output = {
  readyForIrreversibleProcessing: attestation.evaluation.readyForIrreversibleProcessing,
  backupState: attestation.capabilities.backup?.state ?? 'UNDECLARED',
  notificationsState: attestation.capabilities.notifications?.state ?? 'UNDECLARED',
  backupPolicyVersion: attestation.evaluation.backupPolicyVersion,
  notificationPolicyVersion: attestation.evaluation.notificationPolicyVersion,
  blockers: attestation.evaluation.blockers,
};

console.log(JSON.stringify(output));
if (!attestation.evaluation.readyForIrreversibleProcessing) process.exitCode = 1;
