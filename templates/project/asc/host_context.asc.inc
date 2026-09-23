static inline MeteorStatus meteor_describe_call(
    const MeteorCall& call, MeteorShape& shape, MeteorResources& resources)
{
    if (call.info_x1.numTensors <= 0 || call.info_x2.numTensors <= 0 ||
        call.info_x1Scale.numTensors <= 0 || call.info_x2Scale.numTensors <= 0 ||
        call.info_y.numTensors <= 0 || call.info_yScale.numTensors <= 0 ||
        call.info_x1.tensors == nullptr || call.info_x2.tensors == nullptr ||
        call.info_x1Scale.tensors == nullptr || call.info_x2Scale.tensors == nullptr ||
        call.info_y.tensors == nullptr || call.info_yScale.tensors == nullptr ||
        call.info_x1.tensors[0].shape == nullptr || call.info_x2.tensors[0].shape == nullptr ||
        call.info_x1Scale.tensors[0].shape == nullptr || call.info_x2Scale.tensors[0].shape == nullptr ||
        call.info_y.tensors[0].shape == nullptr || call.info_yScale.tensors[0].shape == nullptr) {
        return MeteorStatus::InvalidInput;
    }

    if (call.info_x1.tensors[0].numDims != 2 || call.info_x2.tensors[0].numDims != 2 ||
        call.info_x1Scale.tensors[0].numDims != 1 || call.info_x2Scale.tensors[0].numDims != 1 ||
        call.info_y.tensors[0].numDims != 2 || call.info_yScale.tensors[0].numDims != 1) {
        return MeteorStatus::InvalidInput;
    }

    if (call.info_x1.tensors[0].dtype != 3 || call.info_x2.tensors[0].dtype != 3 ||
        call.info_x1Scale.tensors[0].dtype != 0 || call.info_x2Scale.tensors[0].dtype != 0 ||
        call.info_y.tensors[0].dtype != 3 || call.info_yScale.tensors[0].dtype != 0) {
        return MeteorStatus::InvalidInput;
    }

    const int64_t m64 = call.info_x1.tensors[0].shape[0];
    const int64_t k64 = call.info_x1.tensors[0].shape[1];
    const int64_t n64 = call.info_x2.tensors[0].shape[0];
    const int64_t k2_64 = call.info_x2.tensors[0].shape[1];
    if (m64 <= 0 || n64 <= 0 || k64 <= 0 || k2_64 <= 0 ||
        m64 > 0xFFFFFFFFLL || n64 > 0xFFFFFFFFLL || k64 > 0xFFFFFFFFLL ||
        k64 != k2_64) {
        return MeteorStatus::InvalidInput;
    }

    if (call.info_x1Scale.tensors[0].shape[0] != m64 ||
        call.info_x2Scale.tensors[0].shape[0] != n64 ||
        call.info_y.tensors[0].shape[0] != m64 ||
        call.info_y.tensors[0].shape[1] != n64 ||
        call.info_yScale.tensors[0].shape[0] != m64) {
        return MeteorStatus::InvalidInput;
    }

    if (call.availableCoreNum <= 0 || call.availableCoreNum > 0x7FFFFFFFLL) {
        return MeteorStatus::ResourceRejected;
    }
    shape = MeteorShape{
        static_cast<uint32_t>(m64),
        static_cast<uint32_t>(n64),
        static_cast<uint32_t>(k64),
    };
    resources = MeteorResources{
        static_cast<int32_t>(call.availableCoreNum),
        0, // Vector core count is unknown at this ABI; never infer it from Cube cores.
        0U, 0U, 0U, 0U, 0U,
    };
    return MeteorStatus::Success;
}
