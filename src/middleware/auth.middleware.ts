import jwt from "jsonwebtoken";

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.sendStatus(401);

  try {
    req.user = jwt.verify(
      header.split(" ")[1],
      process.env.ACCESS_TOKEN_SECRET,
    );
    next();
  } catch {
    res.sendStatus(401);
  }
};

export const requireRole = (role) => (req, res, next) => {
  if (req.user.role !== role) return res.sendStatus(403);
  next();
};
