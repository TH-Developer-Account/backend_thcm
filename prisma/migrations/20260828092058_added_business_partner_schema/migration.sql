-- CreateEnum
CREATE TYPE "BusinessPartnerOfficeType" AS ENUM ('HEAD_OFFICE', 'BRANCH_OFFICE');

-- CreateTable
CREATE TABLE "BusinessPartner" (
    "id" TEXT NOT NULL,
    "internalId" TEXT,
    "vendorId" TEXT,
    "bpId" TEXT,
    "s4Id" TEXT,
    "bydId" TEXT,
    "c4cId" TEXT,
    "bpName" TEXT NOT NULL,
    "bpShortName" TEXT,
    "isKeyAccount" BOOLEAN NOT NULL DEFAULT false,
    "gst" TEXT,
    "panNumber" TEXT,
    "legalTradeName" TEXT,
    "officeType" "BusinessPartnerOfficeType" NOT NULL,
    "bpType" TEXT,
    "entityType" TEXT,
    "vendorCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedOn" TIMESTAMP(3),
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPartnerAddress" (
    "id" TEXT NOT NULL,
    "businessPartnerId" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "pincode" TEXT,
    "region" TEXT,
    "zone" TEXT,
    "branch" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "email" TEXT,
    "phoneNo" TEXT,
    "website" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPartnerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPartnerContact" (
    "id" TEXT NOT NULL,
    "businessPartnerId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "email" TEXT,
    "panNumber" TEXT,
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "isMainContact" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPartnerContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPartner_internalId_key" ON "BusinessPartner"("internalId");

-- CreateIndex
CREATE INDEX "BusinessPartner_parentId_idx" ON "BusinessPartner"("parentId");

-- CreateIndex
CREATE INDEX "BusinessPartner_bpType_idx" ON "BusinessPartner"("bpType");

-- CreateIndex
CREATE INDEX "BusinessPartner_gst_idx" ON "BusinessPartner"("gst");

-- CreateIndex
CREATE INDEX "BusinessPartnerAddress_businessPartnerId_idx" ON "BusinessPartnerAddress"("businessPartnerId");

-- CreateIndex
CREATE INDEX "BusinessPartnerContact_businessPartnerId_idx" ON "BusinessPartnerContact"("businessPartnerId");

-- CreateIndex
CREATE INDEX "BusinessPartnerContact_userId_idx" ON "BusinessPartnerContact"("userId");

-- AddForeignKey
ALTER TABLE "BusinessPartner" ADD CONSTRAINT "BusinessPartner_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "BusinessPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPartnerAddress" ADD CONSTRAINT "BusinessPartnerAddress_businessPartnerId_fkey" FOREIGN KEY ("businessPartnerId") REFERENCES "BusinessPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPartnerContact" ADD CONSTRAINT "BusinessPartnerContact_businessPartnerId_fkey" FOREIGN KEY ("businessPartnerId") REFERENCES "BusinessPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPartnerContact" ADD CONSTRAINT "BusinessPartnerContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
