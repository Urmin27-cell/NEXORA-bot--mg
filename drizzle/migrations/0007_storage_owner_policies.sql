DO $$
DECLARE b text; op text;
BEGIN
  FOREACH b IN ARRAY ARRAY['post-images','post-videos','product-images','training-files'] LOOP
    FOREACH op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname = b || ' owner ' || lower(op)) THEN
        IF op = 'INSERT' THEN
          EXECUTE format('CREATE POLICY %I ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = %L AND (storage.foldername(name))[1] = auth.uid()::text)', b || ' owner insert', b);
        ELSE
          EXECUTE format('CREATE POLICY %I ON storage.objects FOR %s TO authenticated USING (bucket_id = %L AND (storage.foldername(name))[1] = auth.uid()::text)', b || ' owner ' || lower(op), op, b);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;