import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import mongoose from "mongoose";

export async function DELETE() {
  try {
    await dbConnect();
    await mongoose.connection.db!.collection("jobs").drop();
    return NextResponse.json({ success: true, message: "Collection dropped" });
  } catch (error) {
    console.error("Drop error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
