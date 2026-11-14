import Foundation
import ImageIO
import Vision
import WebKit

private let maximumImageBytes = 8 * 1024 * 1024
private let maximumImageEdge = 2400

enum LocalPdfOcrError: Error, LocalizedError {
    case invalidImage
    case tooLarge
    case cancelled

    var errorDescription: String? {
        switch self {
        case .invalidImage: return "Could not read the scanned page image."
        case .tooLarge: return "The scanned page image exceeds the recognition limit."
        case .cancelled: return "Local scan recognition was cancelled."
        }
    }
}

func recognizeLocalPdfPage(_ bytes: Data) throws -> String {
    try recognizeLocalPdfPage(bytes, request: LocalPdfOcrRequest())
}

private final class LocalPdfOcrRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var recognition: VNRecognizeTextRequest?
    private var cancelled = false

    func start(_ request: VNRecognizeTextRequest) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { throw LocalPdfOcrError.cancelled }
        recognition = request
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let request = recognition
        lock.unlock()
        request?.cancel()
    }

    func check() throws {
        lock.lock()
        defer { lock.unlock() }
        if cancelled { throw LocalPdfOcrError.cancelled }
    }
}

private func recognizeLocalPdfPage(_ bytes: Data, request operation: LocalPdfOcrRequest) throws -> String {
    try operation.check()
    guard bytes.count <= maximumImageBytes else { throw LocalPdfOcrError.tooLarge }
    guard bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
          let image = CGImageSourceCreateWithData(bytes as CFData, nil),
          CGImageSourceGetCount(image) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int else {
        throw LocalPdfOcrError.invalidImage
    }
    guard width > 0, height > 0, width <= maximumImageEdge, height <= maximumImageEdge else {
        throw LocalPdfOcrError.tooLarge
    }
    guard let raster = CGImageSourceCreateImageAtIndex(image, 0, nil) else {
        throw LocalPdfOcrError.invalidImage
    }
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate
    recognition.automaticallyDetectsLanguage = true
    recognition.usesLanguageCorrection = true
    let request = VNImageRequestHandler(cgImage: raster, orientation: .up)
    try operation.start(recognition)
    try request.perform([recognition])
    try operation.check()
    let lines = (recognition.results ?? []).prefix(2000).compactMap {
        $0.topCandidates(1).first?.string
    }
    return String(lines.joined(separator: "\n").prefix(12_000))
}

@MainActor
final class LocalPdfOcrBridge: NSObject, WKScriptMessageHandlerWithReply {
    var authorize: ((WKScriptMessage) -> Bool)?
    private let queue = DispatchQueue(label: "prism.pdf-ocr", qos: .userInitiated)
    private var active: (id: UUID, request: LocalPdfOcrRequest)?

    func cancelActive() {
        active?.request.cancel()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard authorize?(message) == true else {
            replyHandler(nil, "Local scan recognition is unavailable on this page.")
            return
        }
        guard let body = message.body as? [String: Any],
              let idText = body["id"] as? String, let id = UUID(uuidString: idText) else {
            replyHandler(nil, "The scan recognition request is invalid.")
            return
        }
        if body["cancel"] as? Bool == true {
            if active?.id == id { active?.request.cancel() }
            replyHandler(true, nil)
            return
        }
        guard active == nil else {
            replyHandler(nil, "Another scan page is being recognized. Try again shortly.")
            return
        }
        guard let png = body["png"] as? String,
              !png.isEmpty, png.utf8.count <= ((maximumImageBytes + 2) / 3) * 4 else {
            replyHandler(nil, "The scanned page image exceeds the recognition limit.")
            return
        }
        let request = LocalPdfOcrRequest()
        active = (id, request)
        queue.async { [weak self] in
            let result: Result<String, Error> = autoreleasepool {
                Result {
                    guard let bytes = Data(base64Encoded: png) else { throw LocalPdfOcrError.invalidImage }
                    return try recognizeLocalPdfPage(bytes, request: request)
                }
            }
            DispatchQueue.main.async {
                self?.active = nil
                switch result {
                case .success(let text): replyHandler(text, nil)
                case .failure(let error):
                    let description = (error as? LocalPdfOcrError)?.localizedDescription
                    replyHandler(nil, description ?? "macOS could not recognize this scanned page.")
                }
            }
        }
    }
}
