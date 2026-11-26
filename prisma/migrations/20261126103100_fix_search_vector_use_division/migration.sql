-- This is an empty migration.-- Fix build_eventproposal_search_vector(): it still queried the dropped
-- "Department" table (via "department_name") for the EPC full-text search
-- vector. Department was replaced by Division as the org-unit master in
-- migration 20261126043141_repoint_vertical_division_drop_department, but
-- that migration only touched schema-level DDL — this hand-written
-- plpgsql function (originally created in
-- 20260219090047_add_permission_enum) was never updated alongside it,
-- so every EventProposal insert/update started failing with
-- "The table `Department` does not exist in the current database."
-- (the event_proposal_search_trigger BEFORE INSERT OR UPDATE trigger
-- calls event_proposal_search_vector_update(), which calls this function).
--
-- Division has no department_name column — only `name` — see
-- schema.prisma's Division model.

CREATE OR REPLACE FUNCTION public.build_eventproposal_search_vector(
    p_proposal_number text,
    p_event_description text,
    p_location text,
    p_department_id text,
    p_event_name_id text
)
RETURNS tsvector
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    dept_name text;
    event_name text;
BEGIN
    SELECT name
    INTO dept_name
    FROM "Division"
    WHERE id = p_department_id;

    SELECT title
    INTO event_name
    FROM "EventName"
    WHERE id = p_event_name_id;

    RETURN
        setweight(to_tsvector('english', coalesce(p_proposal_number, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(p_event_description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(p_location, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(dept_name, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(event_name, '')), 'B');
END;
$function$;