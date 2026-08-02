CREATE UNIQUE INDEX IF NOT EXISTS `report_version_test_locale_version_uq`
ON `report_versions` (`tenant_id`, `test_id`, `locale`, `version_number`);
--> statement-breakpoint
CREATE TRIGGER `report_versions_immutable_update`
BEFORE UPDATE ON `report_versions`
BEGIN
  SELECT RAISE(ABORT, 'report versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `report_versions_immutable_delete`
BEFORE DELETE ON `report_versions`
BEGIN
  SELECT RAISE(ABORT, 'report versions are immutable');
END;
