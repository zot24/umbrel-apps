-- Runs once when the fake Supabase database is created.
\set pgpass `echo "$POSTGRES_PASSWORD"`
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';

-- Lifeboat's role, as on the real project: reads everything, writes nothing.
CREATE ROLE lifeboat_ro LOGIN PASSWORD 'fake-readonly-password' BYPASSRLS;
GRANT pg_read_all_data TO lifeboat_ro;
ALTER ROLE lifeboat_ro SET default_transaction_read_only = on;
