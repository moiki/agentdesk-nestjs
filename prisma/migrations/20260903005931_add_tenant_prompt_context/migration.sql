-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "brandVoice" TEXT,
ADD COLUMN     "companyDescription" TEXT,
ADD COLUMN     "defaultLanguage" TEXT NOT NULL DEFAULT 'es',
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "supportEmail" TEXT,
ADD COLUMN     "supportPhone" TEXT;
