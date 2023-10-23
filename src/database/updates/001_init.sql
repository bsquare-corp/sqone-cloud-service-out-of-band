CREATE TABLE IF NOT EXISTS `oob_assets` (
  `tenant_id` VARCHAR(32) NOT NULL,
  `asset_id` VARCHAR(255) NOT NULL,
  `boot_id` TEXT NULL DEFAULT NULL,
  `last_active` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `secret_hash` TEXT NOT NULL,

  PRIMARY KEY (`tenant_id`, `asset_id`),
  UNIQUE KEY `oob_asset_id` (`asset_id`)
);

CREATE TABLE IF NOT EXISTS `oob_operations` (
  `tenant_id` VARCHAR(32) NOT NULL,
  `asset_id` VARCHAR(255) NOT NULL,
  `id` BINARY(16) NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `status` VARCHAR(64) NOT NULL,
  `additional_details` TEXT NULL DEFAULT NULL,
  `progress` JSON NULL DEFAULT NULL,
  `parameters` JSON NULL DEFAULT NULL,

  PRIMARY KEY (`tenant_id`, `asset_id`, `id`),
  UNIQUE KEY `oob_operation_id` (`id`),
  CONSTRAINT `oob_operation_fk` FOREIGN KEY (`tenant_id`, `asset_id`) REFERENCES `oob_assets` (`tenant_id`, `asset_id`) ON DELETE CASCADE
);
