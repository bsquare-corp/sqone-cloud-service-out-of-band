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
  `tries` SMALLINT NOT NULL DEFAULT 0 COMMENT 'Once marked as pending the try count should increase by one and then once for each time its fetched after that',
  `additional_details` TEXT NULL DEFAULT NULL COMMENT 'Text for unexpected failure conditions',
  `progress` JSON NULL DEFAULT NULL COMMENT 'Progress object if the device is doing a long operation',
  `parameters` JSON NULL DEFAULT NULL COMMENT 'The parameters used when sending the request to the device',

  PRIMARY KEY (`tenant_id`, `asset_id`, `id`),
  UNIQUE KEY `oob_operation_id` (`id`),
  CONSTRAINT `oob_operation_fk` FOREIGN KEY (`tenant_id`, `asset_id`) REFERENCES `oob_assets` (`tenant_id`, `asset_id`) ON DELETE CASCADE
);
