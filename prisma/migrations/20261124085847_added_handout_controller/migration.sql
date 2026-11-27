-- CreateTable
CREATE TABLE "HandoutRequest" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "fulfillmentType" TEXT NOT NULL DEFAULT 'HAND_DELIVERY',
    "purpose" TEXT NOT NULL,
    "requiredBy" TIMESTAMP(3) NOT NULL,
    "deliverTo" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "remarks" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "addressLandmark" TEXT,
    "addressCity" TEXT,
    "addressDistrict" TEXT,
    "addressState" TEXT,
    "addressPincode" TEXT,
    "addressCountry" TEXT,
    "addressGstin" TEXT,
    "requestedById" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "clarificationReason" TEXT,
    "cannotFulfilReason" TEXT,
    "cancellationReason" TEXT,
    "handedToName" TEXT,
    "deliveredOn" TIMESTAMP(3),
    "deliveryNote" TEXT,
    "deliveredById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoutItem" (
    "id" TEXT NOT NULL,
    "handoutId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "title" TEXT,
    "variantTitle" TEXT,
    "imageUrl" TEXT,
    "rate" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoutOrder" (
    "id" TEXT NOT NULL,
    "handoutId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoutOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HandoutRequest_requestNumber_key" ON "HandoutRequest"("requestNumber");

-- CreateIndex
CREATE UNIQUE INDEX "HandoutOrder_handoutId_key" ON "HandoutOrder"("handoutId");

-- CreateIndex
CREATE UNIQUE INDEX "HandoutOrder_shopifyOrderId_key" ON "HandoutOrder"("shopifyOrderId");

-- AddForeignKey
ALTER TABLE "HandoutRequest" ADD CONSTRAINT "HandoutRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoutRequest" ADD CONSTRAINT "HandoutRequest_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoutItem" ADD CONSTRAINT "HandoutItem_handoutId_fkey" FOREIGN KEY ("handoutId") REFERENCES "HandoutRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoutOrder" ADD CONSTRAINT "HandoutOrder_handoutId_fkey" FOREIGN KEY ("handoutId") REFERENCES "HandoutRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
