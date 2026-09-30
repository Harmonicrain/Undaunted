import express from "express";
import { matchmakingRouter } from "./routes/matchmaker.js";


export const app = express();

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use("/api/matchmaker", matchmakingRouter);