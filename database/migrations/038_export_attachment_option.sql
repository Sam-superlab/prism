ALTER TABLE prism.exports DROP CONSTRAINT exports_formats_check;
ALTER TABLE prism.exports ADD CONSTRAINT exports_formats_check
  CHECK (cardinality(formats)>0 AND formats <@ ARRAY['json','markdown','attachments']::text[]);
