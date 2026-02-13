/* -----------------------------------------------------
   1️⃣ Add search_vector column (if not exists)
----------------------------------------------------- */
ALTER TABLE "EventProposal"
ADD COLUMN IF NOT EXISTS search_vector tsvector;


/* -----------------------------------------------------
   2️⃣ Populate existing rows (including department)
----------------------------------------------------- */
CREATE OR REPLACE FUNCTION build_eventproposal_search_vector(
    p_proposal_number text,
    p_event_description text,
    p_location text,
    p_department_id integer,
    p_event_name_id integer
)
RETURNS tsvector AS $$
DECLARE
    dept_name text;
    event_name text;
BEGIN
    SELECT department_name
    INTO dept_name
    FROM "Department"
    WHERE id = p_department_id;

    SELECT description
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
$$ LANGUAGE plpgsql STABLE;

UPDATE "EventProposal"
SET search_vector = build_eventproposal_search_vector(
    proposal_number,
    event_description,
    location,
    department_id,
    event_name_id
);

/* -----------------------------------------------------
   3️⃣ Create GIN index
----------------------------------------------------- */
CREATE INDEX IF NOT EXISTS event_proposal_search_idx
ON "EventProposal"
USING GIN (search_vector);


/* -----------------------------------------------------
   4️⃣ Trigger function for EventProposal
----------------------------------------------------- */
CREATE OR REPLACE FUNCTION event_proposal_search_vector_update()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        build_eventproposal_search_vector(
            NEW.proposal_number,
            NEW.event_description,
            NEW.location,
            NEW.department_id,
            NEW.event_name_id
        );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/* -----------------------------------------------------
   5️⃣ Attach trigger to EventProposal
----------------------------------------------------- */
DROP TRIGGER IF EXISTS event_proposal_search_trigger
ON "EventProposal";

CREATE TRIGGER event_proposal_search_trigger
BEFORE INSERT OR UPDATE
ON "EventProposal"
FOR EACH ROW
EXECUTE FUNCTION event_proposal_search_vector_update();

/* -----------------------------------------------------
   6️⃣ Trigger for Department name updates
----------------------------------------------------- */
CREATE OR REPLACE FUNCTION department_change_trigger()
RETURNS trigger AS $$
BEGIN
    UPDATE "EventProposal"
    SET department_id = department_id
    WHERE department_id = NEW.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS department_name_update_trigger
ON "Department";

CREATE TRIGGER department_name_update_trigger
AFTER UPDATE OF department_name
ON "Department"
FOR EACH ROW
EXECUTE FUNCTION department_change_trigger();


/* -----------------------------------------------------
   6️⃣ Trigger for Event name updates
----------------------------------------------------- */

CREATE OR REPLACE FUNCTION eventname_change_trigger()
RETURNS trigger AS $$
BEGIN
    UPDATE "EventProposal"
    SET event_name_id = event_name_id
    WHERE event_name_id = NEW.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS eventname_update_trigger
ON "EventName";

CREATE TRIGGER eventname_update_trigger
AFTER UPDATE OF description
ON "EventName"
FOR EACH ROW
EXECUTE FUNCTION eventname_change_trigger();

