## Express + PostgreSQL API (MVC Architecture)

A production-ready Node.js REST API built with Express and PostgreSQL, following a clean MVC architecture with centralized error handling, async wrappers, and structured logging.


## Project Structure

src/
config/
db.js PostgreSQL connection
logger.js Winston logger

controllers/
user.controller.js

models/
user.model.js

routes/
user.routes.js

middleware/
async.middleware.js
error.middleware.js

utils/
apiError.js

app.js
server.js

## Tech Stack

Node.js

Express

PostgreSQL

pg (Postgres client)

Winston (logging)

dotenv (environment variables)

## Installation

Clone the repository

git clone <your-repo-url>
cd project-root

Install dependencies

npm install

Environment Variables

Create a .env file in the root directory with the following values:

PORT=3000
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=yourpassword
DB_NAME=yourdbname
DB_PORT=5432

## Database Setup

Users table (PostgreSQL)

CREATE TABLE users (
id SERIAL PRIMARY KEY,
username VARCHAR(50) UNIQUE NOT NULL,
email VARCHAR(100) UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

## Running the Server

Development mode:

npx nodemon src/server.js

Production mode:

node src/server.js

The server will start on:

http://localhost:3000

## API Endpoints

Base URL:
/api/users

Get all users:
GET /api/users

Get user by ID:
GET /api/users/:id

Create user:
POST /api/users

Request body example:

{
"username": "jdoe",
"email": "jdoe@example.com
",
"password_hash": "hashed_password"
}

## Error Handling

The API uses centralized error handling with:

Custom ApiError class

Async handler middleware

PostgreSQL error mapping (error code 23505 for duplicate keys)

Global error-handling middleware

Example error response:

{
"success": false,
"message": "User not found"
}

## Async Handler Pattern

All async controllers are wrapped using an async handler to avoid repetitive try/catch blocks and to ensure all errors are forwarded to the global error handler.

Example usage:

router.get('/', asyncHandler(controller.getUsers));

## Logging

Winston is used for structured logging

Logs include:

Error messages

Stack traces

Request path and status code

Logs are output in JSON format for easy integration with logging tools

## Best Practices Used

MVC separation (Models, Controllers, Routes)

Centralized error handling

Async-safe controllers

Parameterized SQL queries

Environment-based configuration

Scalable and maintainable folder structure

## Future Improvements

Authentication (JWT and bcrypt)

Request validation (Zod or Joi)

Pagination and filtering

Database migrations (Prisma or Knex)

Docker support

Rate limiting and security headers

License

MIT License
