ALTER TABLE prism.research_references ADD COLUMN import_source jsonb
  CHECK (import_source IS NULL OR coalesce((
    jsonb_typeof(import_source)='object' AND import_source->>'format'='zotero-rdf'
    AND import_source->>'file_sha256' ~ '^[a-f0-9]{64}$'
    AND import_source->>'resource_sha256' ~ '^[a-f0-9]{64}$'
    AND import_source = jsonb_build_object('format',import_source->>'format','file_sha256',import_source->>'file_sha256',
      'resource_sha256',import_source->>'resource_sha256')
  ),false));
