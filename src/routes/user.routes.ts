import { Router } from 'express';
import asyncHandler from '../middleware/async.middleware';
import {getUsers} from '../controllers/user.controller';

const router = Router();

router.get('/', asyncHandler(getUsers));

export default router;
