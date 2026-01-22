const express = require('express');
const asyncHandler = require('../middleware/async.middleware');
const controller = require('../controllers/user.controller');

const router = express.Router();

router.get('/', asyncHandler(controller.getUsers));
router.get('/:id', asyncHandler(controller.getUser));
router.post('/', asyncHandler(controller.createUser));

module.exports = router;
