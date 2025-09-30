import React, { useState } from "react";
import { XCircle, CheckCircle, Upload as UploadIcon, Loader } from "lucide-react";

function Upload({ setFile, setStreamData }) {
  const [localFile, setLocalFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState(null);

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      setLocalFile(file);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!localFile) {
      setError("Please select a file first.");
      return;
    }

    // 1. Reset parent state (clears old transcript/summary)
    setFile(null); 
    setStreamData([]);

    setIsUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append("file", localFile);

    try {
      // 2. Upload the file to the backend
      const response = await fetch("http://localhost:8000/upload-meeting/", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status: ${response.status}`);
      }

      // 3. Set parent state to trigger TranscriptStream component for analysis
      setFile(localFile); 

    } catch (err) {
      console.error("Upload error:", err);
      setError("❌ Upload failed. Check if the backend is running and accessible (http://localhost:8000).");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="my-8 p-6 bg-white rounded-xl shadow-2xl border border-gray-200">
      <h2 className="text-2xl font-semibold text-gray-800 mb-4">Upload a file to begin analysis</h2>
      
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        
        {/* File Input Area */}
        <label 
          htmlFor="file-upload"
          className="flex-grow w-full border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-500 transition duration-150 ease-in-out bg-gray-50"
        >
          <input 
            id="file-upload" 
            type="file" 
            accept=".mp4,.mov,.mp3,.wav" 
            onChange={handleFileChange} 
            className="hidden" 
          />
          <UploadIcon className="mx-auto h-8 w-8 text-blue-500 mb-2" />
          <p className="text-sm font-medium text-gray-600">
            Click to select audio/video
          </p>
          <p className="text-xs text-gray-400 mt-1">
            MP4, MOV, MP3, WAV
          </p>
          {localFile && (
            <div className="mt-2 flex items-center justify-center text-sm font-semibold text-green-700">
              <CheckCircle className="w-4 h-4 mr-1" /> {localFile.name}
            </div>
          )}
        </label>
        
        {/* Upload Button */}
        <button 
          onClick={handleUpload}
          disabled={!localFile || isUploading}
          className={`
            w-full sm:w-auto px-6 py-3 text-white font-bold rounded-xl shadow-md transition duration-300 
            ${!localFile || isUploading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg'}
            flex items-center justify-center
          `}
        >
          {isUploading ? (
            <>
              <Loader className="animate-spin w-5 h-5 mr-2" /> Uploading...
            </>
          ) : (
            "Upload & Analyze"
          )}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg flex items-center">
          <XCircle className="w-5 h-5 mr-2" />
          <span className="font-medium">{error}</span>
        </div>
      )}
    </div>
  );
}

export default Upload;
