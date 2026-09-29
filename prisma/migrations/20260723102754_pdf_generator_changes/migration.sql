-- CreateEnum
CREATE TYPE "VendorAccessTokenPurpose" AS ENUM ('FORM_ACCESS', 'VIEW_PDF');

-- AlterTable
ALTER TABLE "VendorAccessToken" ADD COLUMN     "purpose" "VendorAccessTokenPurpose" NOT NULL DEFAULT 'FORM_ACCESS';
