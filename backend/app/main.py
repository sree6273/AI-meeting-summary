import os
import json
import asyncio
import logging
import re
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool
from transformers import pipeline
import uvicorn

# ------------------- Logging -------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ------------------- FastAPI -------------------
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], # Allow React development server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------- Model Pipelines -------------------
logger.info("Loading models... this may take a while the first time.")
# Using a slightly larger model for better summarization results
ASR_MODEL = os.getenv("ASR_MODEL", "openai/whisper-small") 
SUMMARIZER_MODEL = os.getenv("SUMMARIZER_MODEL", "facebook/bart-large-cnn")

try:
    # Load models once at startup
    asr_pipeline = pipeline("automatic-speech-recognition", model=ASR_MODEL, device=-1) # device=-1 for CPU
    summarizer_pipeline = pipeline("summarization", model=SUMMARIZER_MODEL, device=-1) # device=-1 for CPU
    logger.info("Models loaded successfully.")
except Exception as e:
    logger.error(f"Failed to load models: {e}")
    # Initialize pipelines as None if loading failed
    asr_pipeline = None
    summarizer_pipeline = None


UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ------------------- SSE Helper -------------------
def sse_format(payload: dict) -> str:
    """Serialize payload as JSON for SSE."""
    return f"data: {json.dumps(payload)}\n\n"

# ------------------- Audio Extraction -------------------
async def extract_audio(input_path: str, output_path: str):
    """Use async subprocess for ffmpeg extraction."""
    logger.info(f"Extracting audio from {input_path}")
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", input_path, "-vn", "-acodec", "mp3", output_path,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL
    )
    await process.communicate()
    logger.info(f"Audio extracted to {output_path}")

# ------------------- Endpoints -------------------
@app.post("/upload-meeting/")
async def upload_meeting(file: UploadFile = File(...)):
    """Save uploaded file and return filename."""
    file_path = os.path.join(UPLOAD_DIR, file.filename)
    # Ensure the file is not empty before reading
    if not file.file:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")
        
    file_content = await file.read()
    with open(file_path, "wb") as f:
        f.write(file_content)
    logger.info(f"File uploaded: {file.filename}")
    return {"filename": file.filename}

@app.get("/transcribe-stream/{filename}")
async def transcribe_stream(filename: str):
    """Stream transcription + summarization over SSE."""
    if not asr_pipeline or not summarizer_pipeline:
        async def error_stream():
            yield sse_format({"tag": "ERROR", "message": "AI models failed to load at startup. Check console logs."})
            yield "data: [DONE]\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    async def event_generator():
        input_path = os.path.join(UPLOAD_DIR, filename)
        if not os.path.exists(input_path):
            yield sse_format({"tag": "ERROR", "message": "File not found on server."})
            yield "data: [DONE]\n\n"
            return

        base_name = os.path.splitext(filename)[0]
        audio_path = os.path.join(UPLOAD_DIR, f"{base_name}_temp_audio.mp3")

        try:
            yield sse_format({"tag": "STATUS", "message": "Connection established. Starting audio extraction..."})
            await asyncio.sleep(0.01)

            # Step 1: Extract audio (non-blocking external command)
            await extract_audio(input_path, audio_path)

            # Step 2: Run ASR (blocking model run in threadpool)
            yield sse_format({"tag": "STATUS", "message": "Running speech recognition... (This may take a moment)"})
            
            asr_result = await run_in_threadpool(
                asr_pipeline, 
                audio_path,
                chunk_length_s=30, 
                ignore_warning=True 
            )
            
            transcript_text = asr_result["text"].strip()
            logger.info(f"Transcript length: {len(transcript_text)} characters")

            # Stream transcript in ~12 chunks
            words = transcript_text.split()
            chunk_size = max(1, len(words) // 12)
            
            # Use transcript_chunk to store parts being streamed
            for i in range(0, len(words), chunk_size):
                chunk = " ".join(words[i:i + chunk_size])
                yield sse_format({"transcript": chunk})

            yield sse_format({"tag": "STATUS", "message": "Transcription complete. Starting structured analysis..."})
            
            # Step 3: Summarization and Structured Extraction
            
            # FIX: Use Python's built-in 're' module for sentence splitting.
            # This is robust and avoids errors from specific tokenizer versions.
            sentences = re.split(r'(?<=[.?!])\s+', transcript_text)
            sentences = [s.strip() for s in sentences if s.strip()]
            
            current_chunk = []
            current_len = 0
            sentence_chunks = []
            # Group sentences into chunks of ~400 words for summarization
            for sentence in sentences:
                if current_len + len(sentence.split()) > 400:
                    sentence_chunks.append(" ".join(current_chunk))
                    current_chunk, current_len = [], 0
                current_chunk.append(sentence)
                current_len += len(sentence.split())

            if current_chunk:
                sentence_chunks.append(" ".join(current_chunk))

            logger.info(f"Generated {len(sentence_chunks)} chunks for summarization")
            yield sse_format({"tag": "STATUS", "message": f"Summarizing {len(sentence_chunks)} text blocks..."})

            # --- 3a. General Summary Generation (Chunked) ---
            full_summary_parts = []
            for idx, chunk in enumerate(sentence_chunks, 1):
                summary_result = await run_in_threadpool(
                    summarizer_pipeline,
                    chunk,
                    max_length=120,
                    min_length=30,
                    do_sample=False
                )
                summary_text = summary_result[0]["summary_text"]
                full_summary_parts.append(summary_text)
                # Stream each summary chunk
                yield sse_format({"summary": summary_text})
            
            # --- 3b. Key Decisions Extraction ---
            yield sse_format({"tag": "STATUS", "message": "Extracting Key Decisions..."})
            decision_prompt = f"From the following transcript, identify and list any key decisions made. If no clear decisions are found, state 'No key decisions were explicitly mentioned.': {transcript_text}"
            
            decision_result = await run_in_threadpool(
                summarizer_pipeline,
                decision_prompt,
                max_length=150,
                min_length=10,
                do_sample=False
            )
            decision_text = decision_result[0]["summary_text"].strip()
            yield sse_format({"decision": decision_text})

            # --- 3c. Action Items Extraction ---
            yield sse_format({"tag": "STATUS", "message": "Extracting Action Items..."})
            action_prompt = f"From the following transcript, list all action items or next steps assigned to individuals. If none are found, state 'No specific action items were assigned.': {transcript_text}"
            
            action_result = await run_in_threadpool(
                summarizer_pipeline,
                action_prompt,
                max_length=150,
                min_length=10,
                do_sample=False
            )
            action_text = action_result[0]["summary_text"].strip()
            yield sse_format({"action_item": action_text})

            yield sse_format({"tag": "STATUS", "message": "Structured analysis complete. Report ready."})

        except Exception as e:
            logger.error(f"Processing failed: {e}", exc_info=True)
            yield sse_format({"tag": "ERROR", "message": f"Processing failed: {str(e)}"})

        finally:
            # Final completion signal
            yield "data: [DONE]\n\n"
            if os.path.exists(audio_path):
                os.remove(audio_path)
                logger.info(f"Cleaned up {audio_path}")
            # Note: The original uploaded file is kept in the uploads folder.

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# The entry point when running with start_app.sh or uvicorn directly
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
