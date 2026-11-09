import AVFoundation
import AppKit

let input = "/Users/curious/Desktop/drone/drone-sim.mp4"
let output = "/private/var/folders/8f/sthz3w_56w5czfjrq5475vgr0000gn/T/opencode/drone-video-frames-av"
try? FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)

let asset = AVURLAsset(url: URL(fileURLWithPath: input))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.2, preferredTimescale: 600)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.2, preferredTimescale: 600)
generator.maximumSize = CGSize(width: 1600, height: 900)

let duration = asset.duration.seconds
print("duration", duration)

var times: [Double] = [0.2]
var t = 5.0
while t < duration - 1 {
    times.append(t)
    t += 5.0
}
times.append(duration - 0.3)

for (index, time) in times.enumerated() {
    do {
        let cg = try generator.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 600), actualTime: nil)
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .png, properties: [:]) else { continue }
        let name = String(format: "frame-%02d-%05.1fs.png", index, time)
        try data.write(to: URL(fileURLWithPath: "\(output)/\(name)"))
        print(name)
    } catch {
        print("failed", time, error)
    }
}
