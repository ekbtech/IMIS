# Backup and disaster recovery baseline

This is a planning baseline; no RPO/RTO or retention period has been approved. Hospital management, county ICT, clinical leadership and privacy/legal leadership must set targets and retention rules before production.

1. Back up database and attachments using encrypted, access-separated tooling with keys held in an approved managed key store.
2. Keep at least one immutable/offline or separately administered copy; prevent application credentials from deleting backups.
3. Monitor backup completion, age, encryption and storage capacity. Alert on failed or stale backups.
4. Record database version, migration level, backup timestamp, encryption key identifier and restore procedure without logging secrets.
5. Test restoration on isolated infrastructure at an approved cadence; validate row counts, constraints, application startup and data integrity.
6. Document business continuity and downtime clinical workflows; define reconciliation steps for paper or offline records.
7. Exercise ransomware, site outage, credential compromise and data-integrity scenarios. Record results, recovery time and corrective actions.
8. Define authorized access, incident escalation, breach assessment/notification, secure retention and disposal with the controller/DPO.

Never treat the local Docker database volume as a backup.
