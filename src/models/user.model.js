const pool = require('../config/db');

const getAllUsers = async () => {
  const { rows } = await pool.query(
    'SELECT id, username, email, created_at FROM users ORDER BY id'
  );
  return rows;
};

const getUserById = async (id) => {
  const { rows } = await pool.query(
    'SELECT id, username, email, created_at FROM users WHERE id = $1',
    [id]
  );
  return rows[0];
};

const createUser = async ({ username, email, password_hash }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, email, created_at`,
    [username, email, password_hash]
  );
  return rows[0];
};

module.exports = {
  getAllUsers,
  getUserById,
  createUser,
};
