-- Add search vector column
ALTER TABLE "EventProposal"
ADD COLUMN search_vector tsvector;

-- Populate existing rows
UPDATE "EventProposal"
SET search_vector =
  to_tsvector('english',
    coalesce(proposal_number, '') || ' ' ||
    coalesce(location, '') || ' ' ||
    coalesce(event_description, '')
  );

-- Create GIN index
CREATE INDEX event_proposal_search_idx
ON "EventProposal"
USING GIN (search_vector);

-- Create trigger function
CREATE OR REPLACE FUNCTION event_proposal_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector('english',
      coalesce(NEW.proposal_number, '') || ' ' ||
      coalesce(NEW.location, '') || ' ' ||
      coalesce(NEW.event_description, '')
    );
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Attach trigger
CREATE TRIGGER event_proposal_search_trigger
BEFORE INSERT OR UPDATE
ON "EventProposal"
FOR EACH ROW
EXECUTE FUNCTION event_proposal_search_vector_update();
