import { Router } from "express";

const testRouter = Router();

testRouter.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

export default testRouter;
