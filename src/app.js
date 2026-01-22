const express = require('express');
require('dotenv').config();

const userRoutes = require('./routes/user.routes');
const errorHandler = require('./middleware/error.middleware');
const ApiError = require('./utils/apiError');

const app = express();

app.use(express.json());

app.use('/api/users', userRoutes);

/* 404 */
app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
});

/* Global error handler */
app.use(errorHandler);

module.exports = app;
