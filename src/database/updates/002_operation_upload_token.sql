-- upload_token will be stored plain text and not hashed because it's relatively low security
-- so the hashing computational overhead doesn't make sense. It's really only there to stop
-- uploads if you only knew the operation ID.
ALTER TABLE `oob_operations`
  ADD `upload_token` TEXT NULL DEFAULT NULL;
