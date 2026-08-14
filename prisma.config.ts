import { ENV } from "./src/common/constants";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: ENV.DATABASE_URL,
    shadowDatabaseUrl: ENV.SHADOW_DATABASE_URL,
  },
});
