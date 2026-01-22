const User = require('../models/user.model');
const ApiError = require('../utils/apiError');

const getUsers = async (req, res) => {
  const users = await User.getAllUsers();
  res.status(200).json(users);
};

const getUser = async (req, res) => {
  const user = await User.getUserById(req.params.id);

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  res.status(200).json(user);
};

const createUser = async (req, res) => {
  const user = await User.createUser(req.body);
  res.status(201).json(user);
};

module.exports = {
  getUsers,
  getUser,
  createUser,
};
