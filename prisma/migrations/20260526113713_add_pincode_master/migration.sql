-- CreateTable
CREATE TABLE "Pincode" (
    "id" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "officeName" TEXT NOT NULL,
    "officeType" TEXT NOT NULL,
    "delivery" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "stateName" TEXT NOT NULL,
    "circleName" TEXT NOT NULL,
    "regionName" TEXT NOT NULL,
    "divisionName" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "searchVector" tsvector,

    CONSTRAINT "Pincode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Pincode_pincode_idx" ON "Pincode"("pincode");

-- CreateIndex
CREATE INDEX "Pincode_stateName_idx" ON "Pincode"("stateName");

-- CreateIndex
CREATE INDEX "Pincode_district_idx" ON "Pincode"("district");

-- CreateIndex (GIN for full-text search)
CREATE INDEX "Pincode_searchVector_idx" ON "Pincode" USING GIN ("searchVector");

-- Trigger function: populates searchVector on INSERT or UPDATE
CREATE OR REPLACE FUNCTION pincode_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW.pincode, '')),         'A') ||
    setweight(to_tsvector('english', coalesce(NEW."officeName", '')),    'B') ||
    setweight(to_tsvector('english', coalesce(NEW.district, '')),        'C') ||
    setweight(to_tsvector('english', coalesce(NEW."stateName", '')),     'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to Pincode table
CREATE TRIGGER pincode_search_vector_trigger
  BEFORE INSERT OR UPDATE ON "Pincode"
  FOR EACH ROW
  EXECUTE FUNCTION pincode_search_vector_update();