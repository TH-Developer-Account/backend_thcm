import { Request, Response, NextFunction } from "express";

const asyncHandler =
  <Req extends Request = Request>(
    fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
  ) =>
  (req: Req, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
