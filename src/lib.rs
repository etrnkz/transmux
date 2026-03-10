use wasm_bindgen::prelude::*;
use web_sys::*;
use serde::{Deserialize, Serialize};

// Import console.log for debugging
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[derive(Serialize, Deserialize)]
pub struct ConversionProgress {
    pub progress: f64,
    pub status: String,
    pub current_time: f64,
    pub duration: f64,
}

#[derive(Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub language: String,
    pub content: String,
    pub format: String,
}

#[wasm_bindgen]
pub struct VideoProcessor {
    worker: Option<Worker>,
    video_element: Option<HtmlVideoElement>,
    progress_callback: Option<js_sys::Function>,
}

#[wasm_bindgen]
impl VideoProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> VideoProcessor {
        console_error_panic_hook::set_once();
        VideoProcessor {
            worker: None,
            video_element: None,
            progress_callback: None,
        }
    }

    #[wasm_bindgen]
    pub fn initialize(&mut self, video_element_id: &str) -> Result<(), JsValue> {
        let window = web_sys::window().unwrap();
        let document = window.document().unwrap();
        
        let video_element = document
            .get_element_by_id(video_element_id)
            .unwrap()
            .dyn_into::<HtmlVideoElement>()?;
        
        self.video_element = Some(video_element);
        
        // Try to initialize FFmpeg worker first, fall back to simple worker
        let worker_result = Worker::new("./ffmpeg-worker.js");
        
        let worker = match worker_result {
            Ok(w) => {
                console_log!("FFmpeg worker initialized");
                w
            },
            Err(_) => {
                console_log!("FFmpeg worker failed, using simple worker");
                Worker::new("./simple-video-worker.js")?
            }
        };
        
        self.worker = Some(worker);
        
        console_log!("VideoProcessor initialized");
        Ok(())
    }

    #[wasm_bindgen]
    pub fn set_progress_callback(&mut self, callback: js_sys::Function) {
        self.progress_callback = Some(callback);
    }

    #[wasm_bindgen]
    pub fn process_video_file(&self, file: &File) -> Result<(), JsValue> {
        if let Some(worker) = &self.worker {
            // Create message for worker
            let message = js_sys::Object::new();
            js_sys::Reflect::set(&message, &"type".into(), &"PROCESS_VIDEO".into())?;
            js_sys::Reflect::set(&message, &"file".into(), &file.into())?;
            
            worker.post_message(&message)?;
            console_log!("Video processing started");
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn extract_subtitles(&self, file: &File) -> Result<(), JsValue> {
        if let Some(worker) = &self.worker {
            let message = js_sys::Object::new();
            js_sys::Reflect::set(&message, &"type".into(), &"EXTRACT_SUBTITLES".into())?;
            js_sys::Reflect::set(&message, &"file".into(), &file.into())?;
            
            worker.post_message(&message)?;
            console_log!("Subtitle extraction started");
        }
        Ok(())
    }

    #[wasm_bindgen]
    pub fn handle_worker_message(&self, event: &MessageEvent) -> Result<(), JsValue> {
        let data = event.data();
        let message_type: String = js_sys::Reflect::get(&data, &"type".into())?
            .as_string()
            .unwrap_or_default();

        match message_type.as_str() {
            "PROGRESS" => {
                if let Some(callback) = &self.progress_callback {
                    let progress_data = js_sys::Reflect::get(&data, &"progress".into())?;
                    callback.call1(&JsValue::NULL, &progress_data)?;
                }
            }
            "VIDEO_READY" => {
                let video_url: String = js_sys::Reflect::get(&data, &"url".into())?
                    .as_string()
                    .unwrap_or_default();
                self.load_video(&video_url)?;
            }
            "SUBTITLES_READY" => {
                let subtitles_data = js_sys::Reflect::get(&data, &"subtitles".into())?;
                self.load_subtitles(&subtitles_data)?;
            }
            "ERROR" => {
                let error_msg: String = js_sys::Reflect::get(&data, &"message".into())?
                    .as_string()
                    .unwrap_or_default();
                console_log!("Worker error: {}", error_msg);
            }
            _ => {}
        }
        Ok(())
    }

    fn load_video(&self, video_url: &str) -> Result<(), JsValue> {
        if let Some(video) = &self.video_element {
            video.set_src(video_url);
            console_log!("Video loaded: {}", video_url);
        }
        Ok(())
    }

    fn load_subtitles(&self, subtitles_data: &JsValue) -> Result<(), JsValue> {
        if let Some(video) = &self.video_element {
            let window = web_sys::window().unwrap();
            let document = window.document().unwrap();
            
            // Create track element for subtitles
            let track = document
                .create_element("track")?
                .dyn_into::<HtmlTrackElement>()?;
            
            track.set_kind("subtitles");
            track.set_label("Extracted Subtitles");
            track.set_srclang("en");
            track.set_default(true);
            
            // Convert subtitle data to VTT format and create blob URL
            let vtt_content: String = js_sys::Reflect::get(subtitles_data, &"vtt".into())?
                .as_string()
                .unwrap_or_default();
            
            let blob_parts = js_sys::Array::new();
            blob_parts.push(&vtt_content.into());
            
            let blob = Blob::new_with_str_sequence(&blob_parts)?;
            let url = Url::create_object_url_with_blob(&blob)?;
            
            track.set_src(&url);
            video.append_child(&track)?;
            
            console_log!("Subtitles loaded");
        }
        Ok(())
    }
}

#[wasm_bindgen]
pub fn get_supported_formats() -> js_sys::Array {
    let formats = js_sys::Array::new();
    formats.push(&"mkv".into());
    formats.push(&"avi".into());
    formats.push(&"mov".into());
    formats.push(&"wmv".into());
    formats.push(&"flv".into());
    formats.push(&"webm".into());
    formats.push(&"mp4".into());
    formats
}

#[wasm_bindgen]
pub fn is_format_supported(format: &str) -> bool {
    matches!(format.to_lowercase().as_str(), "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "mp4")
}