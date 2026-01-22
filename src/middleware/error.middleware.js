const logger = require('../config/logger');
const ApiError = require('../utils/apiError');

const errorHandler = (err, req, res, next) => {
  let error = err;

  /* PostgreSQL errors */
  if (err.code === '23505') {
    error = new ApiError(409, 'Duplicate value violates unique constraint');
  }

  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';

  logger.error({
    message,
    statusCode,
    path: req.originalUrl,
    stack: err.stack,
  });

  res.status(statusCode).json({
    success: false,
    message,
  });
};

module.exports = errorHandler;
