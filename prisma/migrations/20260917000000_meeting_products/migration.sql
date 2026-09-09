-- A meeting is about one or more of the products the team sells, so it is tagged rather than
-- categorised: PHH, Acubooth and Glynac can all come up in the same conversation.
ALTER TABLE "Meeting" ADD COLUMN "products" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
